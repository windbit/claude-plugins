// Журнал топиков: append-only JSONL про жизнь биндингов. bindings.json хранит только ЖИВОЕ —
// `/unbind` и `/delete` стирают строку, и вместе с ней единственную связь «топик → папка,
// ветка, сессия». Журнал её переживает, поэтому в закрытый топик можно вернуться.
//
// Формат — по строке на событие: строка пишется одним `appendFileSync`, битую строку читатель
// пропускает. Ротацию делает вызывающий; свёртку в кандидатов — `foldJournal` ниже.
import { safeJsonParse } from './util'
import type { AgentKind } from './agents/types'
import type { TrustedGroupMode } from './trusted-groups'

/** Почему топик перестал существовать. `delete` = снесли вместе с папкой, `unbind` = только отвязали. */
export type TopicGoneReason = 'unbind' | 'delete'

export type TopicEvent =
  | {
    kind: 'bound'
    ts: number
    key: string
    chatId: string
    /** Имя топика на момент привязки: в транскрипте его нет, а на кнопке нужно именно оно. */
    title?: string
    dir: string
    branch?: string
    mode?: TrustedGroupMode
    agent?: AgentKind
  }
  | { kind: 'session'; ts: number; key: string; sessionId: string }
  | { kind: 'gone'; ts: number; key: string; reason: TopicGoneReason; dirRemoved: boolean }

/** Свёрнутая история одного топика — то, из чего строится кнопка возврата. */
export type TopicRecord = {
  key: string
  chatId: string
  title?: string
  dir: string
  branch?: string
  mode?: TrustedGroupMode
  agent?: AgentKind
  sessionId?: string
  /** Время последнего события — честнее, чем mtime транскрипта: тот трогает и наш же опрос. */
  lastSeen: number
  status: 'live' | 'unbound' | 'deleted'
  /** Папку снесли вместе с топиком: ворктри придётся резать заново, по ветке. */
  dirRemoved: boolean
}

export function encodeEvent(event: TopicEvent): string {
  return `${JSON.stringify(event)}\n`
}

/** Разбор журнала. Битая строка (обрыв записи, чужой формат) пропускается молча — иначе одна
 *  повреждённая запись стоила бы всей истории. */
export function parseJournal(text: string): TopicEvent[] {
  const out: TopicEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }
    const parsed = safeJsonParse<Partial<TopicEvent>>(line)
    if (!parsed || typeof parsed.key !== 'string' || typeof parsed.ts !== 'number') {
      continue
    }
    if (parsed.kind === 'bound' && typeof (parsed as { dir?: unknown }).dir === 'string') {
      out.push(parsed as TopicEvent)
    } else if (parsed.kind === 'session' && typeof (parsed as { sessionId?: unknown }).sessionId === 'string') {
      out.push(parsed as TopicEvent)
    } else if (parsed.kind === 'gone') {
      out.push(parsed as TopicEvent)
    }
  }
  return out
}

/** Свёртка событий в историю по топику: последняя привязка побеждает, sessionId — самый свежий.
 *  Один топик поднимался много раз, и кнопка обязана предлагать последнюю попытку, а не первую. */
export function foldJournal(events: TopicEvent[]): TopicRecord[] {
  const byKey = new Map<string, TopicRecord>()
  for (const event of [...events].sort((a, b) => a.ts - b.ts)) {
    const known = byKey.get(event.key)
    if (event.kind === 'bound') {
      // Новая привязка = новая жизнь топика: старую сессию и статус не тащим.
      byKey.set(event.key, {
        key: event.key,
        chatId: event.chatId,
        dir: event.dir,
        lastSeen: event.ts,
        status: 'live',
        dirRemoved: false,
        ...(event.title ? { title: event.title } : {}),
        ...(event.branch ? { branch: event.branch } : {}),
        ...(event.mode ? { mode: event.mode } : {}),
        ...(event.agent ? { agent: event.agent } : {}),
      })
      continue
    }
    if (!known) {
      continue // событие без привязки — журнал обрезан ротацией, восстанавливать нечего
    }
    known.lastSeen = event.ts
    if (event.kind === 'session') {
      known.sessionId = event.sessionId
    } else {
      known.status = event.reason === 'delete' ? 'deleted' : 'unbound'
      known.dirRemoved = event.dirRemoved
    }
  }
  return [...byKey.values()]
}

export type CandidateFilter = {
  /** Чат топика: истории соседней группы и личных чатов в списке быть не должно. */
  chatId: string
  now: number
  maxAgeMs: number
  limit: number
  /** Ключи с живым биндингом — они и так на своём месте, возвращаться в них не надо. */
  liveKeys?: string[]
}

/** Кандидаты на возврат: своя группа, есть куда возвращаться, свежие сверху. */
export function resumeCandidates(records: TopicRecord[], filter: CandidateFilter): TopicRecord[] {
  const live = new Set(filter.liveKeys ?? [])
  return records
    .filter(r => r.chatId === filter.chatId
      && !!r.sessionId
      && !live.has(r.key)
      && filter.now - r.lastSeen <= filter.maxAgeMs)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, filter.limit)
}

/** Почему кандидата нельзя поднять как есть. Причины различаем: пользователю нужен разный ответ,
 *  а нам — разный путь (пересрезать ворктри против «сессия занята»). */
export type CandidateBlock = 'no-dir' | 'no-transcript' | 'owned'

export function candidateBlock(record: TopicRecord, facts: {
  dirExists: boolean
  transcriptExists: boolean
  ownerKey?: string
}): CandidateBlock | undefined {
  if (facts.ownerKey && facts.ownerKey !== record.key) {
    return 'owned' // разговор уже читает другой топик — два пейна на один транскрипт путают ответы
  }
  if (!facts.dirExists) {
    return 'no-dir'
  }
  if (!facts.transcriptExists) {
    return 'no-transcript' // id остался, транскрипт вычистили — иначе поднимется ПУСТАЯ сессия
  }
  return undefined
}
