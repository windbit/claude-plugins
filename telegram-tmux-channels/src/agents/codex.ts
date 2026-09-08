import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { AgentAdapter, AgentStatusPanel, LaunchMode, RecentAgentSession } from './types'
import { shellQuote } from '../tmux-ops'
import { isCodexArgv } from '../proc'
import { STATE_DIR } from '../paths'

type RolloutMeta = { id: string; cwd: string }
type Rollout = RolloutMeta & { path: string; mtime: number; firstUser: string }

export { isCodexArgv }

export function isCodexHeadlessArgv(argv: string[]): boolean {
  const i = argv.findIndex(a => isCodexArgv([a]))
  return i >= 0 && argv.slice(i + 1).some(a => a === 'exec' || a === 'review')
}

// Из сохранённого argv убираем прошлую подкоманду жизненного цикла вместе с её id: она относится
// к ТОМУ запуску, а новый режим добавит свою. Ищем её по всему хвосту, а не на позиции 1: перед
// ней теперь стоят флаги (`--ask-for-approval never`), и проверка индекса давала `resume … resume …`
// — codex такое не принимает, сессия падала сразу после старта.
function stripLifecycle(argv: string[]): string[] {
  const i = argv.findIndex(a => isCodexArgv([a]))
  const base = i >= 0 ? argv.slice(i) : ['codex']
  const life = base.findIndex((a, idx) => idx > 0 && (a === 'resume' || a === 'fork'))
  return life > 0 ? base.slice(0, life) : base
}

// Сессией из Telegram управляет человек в чате, а не за терминалом: спросить «разрешить вызов
// тула?» некому. Первым же таким вопросом становится наш собственный `reply` — и ответ агента
// вместо чата уезжает в пикер. У Claude ту же роль играет `--permission-mode bypassPermissions`,
// который мы прописываем в запуске; здесь эквивалент — не спрашивать одобрений.
const NO_APPROVALS = ['--ask-for-approval', 'never']
// Дефолтная песочница Codex (`workspace-write`) даёт запись только в рабочий каталог и глушит
// сеть, а поднять права он умеет лишь спросив — то есть при `never` не умеет вовсе. Получается
// агент, который не может ни склонировать репозиторий, ни поставить пакет. У Claude в том же
// запуске стоит `--permission-mode bypassPermissions`; это его эквивалент.
const FULL_ACCESS = ['--sandbox', 'danger-full-access']
const SANDBOX_FLAGS = ['--sandbox', '-s', '--dangerously-bypass-approvals-and-sandbox']

// Другой размен: вопросы не гасить, а показывать кнопками в чате. Модалка одобрения Codex —
// обычный пикер с footer'ом «Esc to cancel», мост уводит её в Telegram сам, кода не нужно.
// Тогда и песочница остаётся дефолтной: без неё спрашивать не о чем. Плата — round-trip в чат
// на каждую команду вне рабочего каталога, поэтому по умолчанию выключено.
const APPROVALS_IN_CHAT = ['--ask-for-approval', 'on-request']

function withDefaults(base: string[]): string[] {
  const inChat = process.env.TELEGRAM_CODEX_APPROVALS === '1'
  const flags = [
    ...(base.includes('--ask-for-approval') ? [] : inChat ? APPROVALS_IN_CHAT : NO_APPROVALS),
    ...(inChat || base.some(a => SANDBOX_FLAGS.includes(a)) ? [] : FULL_ACCESS),
  ]
  return flags.length ? [base[0]!, ...flags, ...base.slice(1)] : base
}

export function buildCodexLaunch(
  saved: string[] | undefined,
  mode: LaunchMode,
  sessionId?: string,
): string {
  const base = withDefaults(stripLifecycle(saved?.length ? saved : ['codex']))
  if (mode === 'new') return shellQuote(base)
  const command = mode === 'fork' ? 'fork' : 'resume'
  return shellQuote([...base, command, ...(sessionId ? [sessionId] : ['--last'])])
}

function stringsFromContent(content: unknown, field: 'input_text' | 'output_text'): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(v => {
    if (!v || typeof v !== 'object') return []
    const p = v as { type?: string; text?: string }
    return p.type === field && typeof p.text === 'string' ? [p.text] : []
  })
}

function rolloutUserSnippet(content: unknown): string {
  return stringsFromContent(content, 'input_text').join(' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

// Codex records its launch envelope as a role=user item before the human's first turn. It is
// useful provenance but a terrible resume label ("cwd … shell …"). Keep scanning until the
// first actual request; old/minimal rollouts still simply have an empty snippet.
function isBootstrapEnvelope(text: string): boolean {
  return text.includes('<environment_context>') || text.includes('<developer_instructions>')
    || text.includes('<skills_instructions>') || text.includes('<app-context>')
}

function displayRolloutSnippet(text: string): string {
  // Telegram routing metadata is needed in the transcript, but repeating chat/topic ids in every
  // resume button hides the actual request. Strip exactly the leading envelope only.
  return text.replace(/^\[Telegram message;[^\n]*\]\s*/u, '').trim()
}

function readHead(path: string, bytes: number): string {
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, bytes))
      readSync(fd, buf, 0, buf.length, 0)
      return buf.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return '' }
}

/** Первая строка роллаута — `session_meta`, и в ней уже есть всё для отбора: id, папка, происхождение. */
export function parseRolloutMeta(firstLine: string): RolloutMeta | undefined {
  let row: { type?: string; payload?: Record<string, unknown> }
  try { row = JSON.parse(firstLine) } catch { return undefined }
  if (row.type !== 'session_meta') return undefined
  const id = String(row.payload?.id ?? '')
  const cwd = String(row.payload?.cwd ?? '')
  // У сабагента `source` — объект с деталями порождения, у настоящей сессии строка ('cli'/'exec').
  // Роллауты сабагентов лежат теми же файлами и с той же папкой: у habebe-trader их больше, чем
  // сессий, и пикер показывал бы почти одних их.
  if (!id || !cwd || typeof row.payload?.source === 'object') return undefined
  return { id, cwd }
}

// Голову читаем в два приёма: сперва одну строку метаданных (её потолок — 38 КБ), и только у
// совпавших по папке лезем за подписью вглубь. Скан всех роллаутов стоил 3.1 с и звался из пяти
// горячих путей; с предфильтром — 0.4 с.
const META_HEAD_BYTES = 64 * 1024
const SNIPPET_HEAD_BYTES = 256 * 1024

function parseRollout(path: string): Rollout | undefined {
  const meta = parseRolloutMeta(readHead(path, META_HEAD_BYTES).split('\n', 1)[0] ?? '')
  if (!meta) return undefined
  const text = readHead(path, SNIPPET_HEAD_BYTES)
  let firstUser = ''
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const row = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> }
      if (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user') {
        const raw = stringsFromContent(row.payload.content, 'input_text').join(' ')
        if (!isBootstrapEnvelope(raw)) { firstUser = rolloutUserSnippet(row.payload.content); break }
      }
    } catch {}
  }
  try { return { ...meta, path, firstUser, mtime: statSync(path).mtimeMs } } catch { return undefined }
}

function walkRollouts(root: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const path = join(root, e.name)
    if (e.isDirectory()) walkRollouts(path, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

function codexSessionsRoot(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'sessions')
}

// Метаданные роллаутов кэшируем по (mtime, size) И держим на диске: у Codex нет каталога по
// проекту, поэтому «сессии этой папки» — это обход ВСЕХ роллаутов (у нас 2664 файла, 588 МБ).
// Без диска первый вызов после рестарта хаба читал их заново — 8.8 с на холодном кэше; с ним
// остаётся только stat каждого файла. Зовут этот путь пять горячих мест: доставка, сторож
// ответа, /status, пикер и учёт нового id.
type IndexEntry = { mtime: number; size: number; meta?: RolloutMeta }
// Путь читаем на каждом обращении, а не на импорте: тесты уводят состояние во временный каталог.
const indexFile = (): string => join(process.env.TELEGRAM_STATE_DIR ?? STATE_DIR, 'codex-index.json')
let metaIndex: Map<string, IndexEntry> | undefined
let indexDirty = false

function loadIndex(): Map<string, IndexEntry> {
  if (metaIndex) return metaIndex
  try {
    const raw = JSON.parse(readFileSync(indexFile(), 'utf8')) as Record<string, IndexEntry>
    metaIndex = new Map(Object.entries(raw))
  } catch { metaIndex = new Map() }
  return metaIndex
}

function saveIndex(): void {
  if (!indexDirty || !metaIndex) return
  indexDirty = false
  try {
    const file = indexFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(Object.fromEntries(metaIndex)))
  } catch {} // индекс — ускоритель, а не состояние: не записался, значит просто перечитаем
}

function rolloutMeta(path: string): { meta?: RolloutMeta; mtime: number } | undefined {
  let stat
  try { stat = statSync(path) } catch { loadIndex().delete(path); return undefined }
  const index = loadIndex()
  const hit = index.get(path)
  if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) {
    return { mtime: stat.mtimeMs, ...(hit.meta ? { meta: hit.meta } : {}) }
  }
  const meta = parseRolloutMeta(readHead(path, META_HEAD_BYTES).split('\n', 1)[0] ?? '')
  index.set(path, { mtime: stat.mtimeMs, size: stat.size, ...(meta ? { meta } : {}) })
  indexDirty = true
  return { mtime: stat.mtimeMs, ...(meta ? { meta } : {}) }
}

// Подпись читается глубже метаданных, но только у файлов совпавшей папки — их единицы.
const snippetCache = new Map<string, string>()

export function codexRollouts(dir: string, root = codexSessionsRoot()): Rollout[] {
  const out: Rollout[] = []
  for (const path of walkRollouts(root)) {
    const head = rolloutMeta(path)
    if (!head?.meta || head.meta.cwd !== dir) continue
    let firstUser = snippetCache.get(path)
    if (firstUser === undefined) {
      firstUser = parseRollout(path)?.firstUser ?? ''
      snippetCache.set(path, firstUser)
    }
    out.push({ ...head.meta, path, firstUser, mtime: head.mtime })
  }
  saveIndex()
  return out
}

function selected(dir: string, sessionId?: string): Rollout | undefined {
  const rows = codexRollouts(dir)
  if (sessionId) return rows.find(r => r.id === sessionId)
  return rows.sort((a, b) => b.mtime - a.mtime)[0]
}

export function codexSessionMtimes(dir: string): Map<string, number> {
  return new Map(codexRollouts(dir).map(r => [r.id, r.mtime]))
}

export function recentCodexSessions(dir: string, limit = 5): RecentAgentSession[] {
  return codexRollouts(dir).sort((a, b) => b.mtime - a.mtime).slice(0, limit)
    .map(r => ({ id: r.id, mtime: r.mtime, snippet: displayRolloutSnippet(r.firstUser) }))
}

export function codexTranscriptSize(dir: string, sessionId?: string): number {
  const row = selected(dir, sessionId)
  if (!row) return 0
  try { return statSync(row.path).size } catch { return 0 }
}

function tail(path: string): string {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - 262144)
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)
    return buf.toString('utf8')
  } catch { return '' }
}

export function lastCodexAssistantText(dir: string, sinceMs: number, sessionId?: string): string {
  const row = selected(dir, sessionId)
  if (!row || row.mtime < sinceMs - 2000) return ''
  const lines = tail(row.path).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { timestamp?: string; type?: string; payload?: Record<string, unknown> }
      if (event.type !== 'response_item' || event.payload?.type !== 'message' || event.payload.role !== 'assistant') continue
      if (event.payload.phase && event.payload.phase !== 'final_answer') continue
      const text = stringsFromContent(event.payload.content, 'output_text').join('\n\n').trim()
      if (!text) continue
      return event.timestamp && Date.parse(event.timestamp) < sinceMs ? '' : text
    } catch {}
  }
  return ''
}

export function codexAssistantDraftText(dir: string, sinceMs: number, sessionId?: string): string {
  const row = selected(dir, sessionId)
  if (!row || row.mtime < sinceMs - 2000) return ''
  const lines = tail(row.path).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { timestamp?: string; type?: string; payload?: Record<string, unknown> }
      if (event.type !== 'event_msg' || event.payload?.type !== 'agent_message') continue
      const text = typeof event.payload.message === 'string' ? event.payload.message.trim() : ''
      if (!text) continue
      return event.timestamp && Date.parse(event.timestamp) < sinceMs ? '' : text
    } catch {}
  }
  return ''
}

export function codexTranscriptSawIncoming(dir: string, sinceMs: number, needle: string): boolean {
  for (const row of codexRollouts(dir)) {
    if (row.mtime < sinceMs - 2000) continue
    for (const line of tail(row.path).split('\n')) {
      try {
        const event = JSON.parse(line) as { timestamp?: string; type?: string; payload?: Record<string, unknown> }
        if (event.type !== 'response_item' || event.payload?.type !== 'message' || event.payload.role !== 'user') continue
        if (!event.timestamp || Date.parse(event.timestamp) < sinceMs - 2000) continue
        const text = stringsFromContent(event.payload.content, 'input_text').join('\n')
        if (!needle || text.includes(needle)) return true
      } catch {}
    }
  }
  return false
}

// A Codex rollout is created lazily, on the first user input.  In a shared cwd there can be
// several brand-new rollouts at once, so mtime alone is not an identity.  The Telegram envelope
// and message text are written into that rollout; use that durable evidence to bind it to its
// originating topic.
export function codexSessionForIncoming(dir: string, sinceMs: number, needle: string): string | undefined {
  if (!needle) return undefined
  const found = codexRollouts(dir).filter(row => {
    if (row.mtime < sinceMs - 2000) return false
    for (const line of tail(row.path).split('\n')) {
      try {
        const event = JSON.parse(line) as { timestamp?: string; type?: string; payload?: Record<string, unknown> }
        if (event.type !== 'response_item' || event.payload?.type !== 'message' || event.payload.role !== 'user') continue
        if (!event.timestamp || Date.parse(event.timestamp) < sinceMs - 2000) continue
        if (stringsFromContent(event.payload.content, 'input_text').join('\n').includes(needle)) return true
      } catch {}
    }
    return false
  }).sort((a, b) => b.mtime - a.mtime)
  return found[0]?.id
}

export function codexPaneReady(pane: string): boolean {
  // tmux capture-pane preserves the terminal's blank bottom rows. The Codex prompt is often
  // visibly above them, so take the last rendered lines rather than the literal last rows.
  const tail = pane.split('\n').map(s => s.trimEnd()).filter(s => s.trim()).slice(-12)
  return tail.some(line => /^›(?:\s|$)/.test(line.trimStart()))
    && !tail.some(line => /Working \(\d+s?\s*[•·]|esc to interrupt/i.test(line))
}

export function codexPaneIsWorking(pane: string): boolean {
  return pane.split('\n').filter(line => line.trim()).slice(-12)
    .some(line => /[•●]\s+Working \(\d+s?\s*[•·].*esc to interrupt/i.test(line.trim()))
}

export function parseCodexError(pane: string): string | undefined {
  const tail = pane.split('\n').map(s => s.trim().replace(/^[•●]\s*/, '')).filter(Boolean).slice(-12)
  return tail.find(line => /^(Error:|Not logged in|Failed to|You've hit your usage limit)/i.test(line))?.slice(0, 300)
}

// Codex 0.147 renders `/status` as a modal panel.  Its values are deliberately parsed only
// from that modal, not from JSONL transcripts (which the official hooks API calls unstable).
// Keep labels verbatim: account plans add or rename quota buckets over time.
export function parseCodexStatusPanel(pane: string): AgentStatusPanel | undefined {
  if (!/OpenAI Codex \(v[\d.]+\)/.test(pane) || !/Weekly limit:/.test(pane)) return undefined
  const panel: AgentStatusPanel = { limits: [] }
  const model = pane.match(/\bModel:\s+([^\n(]+?)(?:\s+\(reasoning|\s*$)/m)?.[1]?.trim()
  if (model) panel.model = model
  const context = pane.match(/\bContext window:\s+(\d+)% left\s+\([^)]*?\)/)
  if (context) {
    panel.contextLeftPct = Number(context[1])
    panel.contextUsedPct = 100 - panel.contextLeftPct
  }
  for (const line of pane.split('\n')) {
    const m = line.match(/^\s*(.+?limit):\s*\[[^\]]*]\s*(\d+)% left\s*\(resets\s+([^)]+)\)/i)
    if (m) panel.limits.push({ label: m[1]!.replace(/^[│|]\s*/, '').trim(), remainingPct: Number(m[2]), resets: m[3]!.trim() })
  }
  panel.stale = /limits may be stale/i.test(pane)
  return panel
}

export function codexCanOpenStatusPanel(pane: string, ansiPane?: string): boolean {
  if (!codexPaneReady(pane)) return false
  // The composer placeholder is dim (SGR 2) while locally typed input is not. Its text rotates
  // between prompts, so this accepts every empty Codex composer without submitting a draft.
  if (ansiPane) {
    const promptLine = [...ansiPane.split('\n')].reverse().find(line => line.includes('›'))
    if (promptLine) return /›(?:\x1b\[[0-9;]*m)?\s*\x1b\[2m/.test(promptLine)
  }
  // Codex displays this placeholder for an empty composer.  Any other text after `›` is a
  // local draft; this conservative no-ANSI fallback is for terminals without styling.
  const lines = pane.split('\n').map(line => line.trim()).filter(Boolean)
  const prompt = [...lines].reverse().find(line => line.startsWith('›'))
  return prompt === '›' || prompt === '› Find and fix a bug in @filename'
}

const noPct = (): undefined => undefined

export const codexAdapter: AgentAdapter = {
  kind: 'codex',
  displayName: 'Codex',
  capabilities: {
    nativeInboundTransport: false,
    nativeReplyTool: false,
    permissions: true,
    resume: true,
    liveResumePicker: false,
    fork: true,
    modelPicker: true,
    taskStatus: true,
    subagentStatus: true,
    skillStatus: true,
    backgroundStatus: true,
    captureSessionIdAtLaunch: false,
    hookSessionIdReliable: false,
  },
  isProcessArgv: isCodexArgv,
  isPaneCommand: command => /(^|\/)codex(?:\.exe)?$/i.test(command.trim()),
  isHeadlessArgv: isCodexHeadlessArgv,
  buildLaunch: buildCodexLaunch,
  sessionMtimes: codexSessionMtimes,
  recentSessions: recentCodexSessions,
  transcriptSize: codexTranscriptSize,
  lastAssistantText: lastCodexAssistantText,
  assistantDraftText: codexAssistantDraftText,
  transcriptSawIncoming: codexTranscriptSawIncoming,
  sessionForIncoming: codexSessionForIncoming,
  // Codex TUI parsing is intentionally explicit rather than reusing Claude signatures.
  // These are filled from captured 0.147 fixtures before hub routing is enabled.
  parseCompaction: noPct,
  paneIsWorking: codexPaneIsWorking,
  parseContextPct: noPct,
  parseError: parseCodexError,
  parseWorkflow: () => undefined,
  paneReady: codexPaneReady,
  statusPanelCommand: '/status',
  canOpenStatusPanel: codexCanOpenStatusPanel,
  parseStatusPanel: parseCodexStatusPanel,
  cachedStatusLines: () => [],
  launchEnvPrefix: keys => `TELEGRAM_BINDING_KEYS=${JSON.stringify(keys.join(','))}`,
}
