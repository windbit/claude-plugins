// Claude stores each conversation as ~/.claude/projects/<slug>/<session-id>.jsonl.
// The hub isn't told the id directly — it snapshots that dir before a fresh launch
// and polls for the new file afterward, same slug rule Claude Code itself uses.
import { readdirSync, statSync, openSync, readSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'

export function claudeProjectDir(dir: string): string {
  return join(homedir(), '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'))
}

export function jsonlMtimes(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  let entries: string[]
  try {
    entries = readdirSync(claudeProjectDir(dir))
  } catch {
    return out
  }
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) {
      continue
    }
    try {
      out.set(f.slice(0, -'.jsonl'.length), statSync(join(claudeProjectDir(dir), f)).mtimeMs)
    } catch {}
  }
  return out
}

// Подпись сессии для пикера. Половина телеграмных сессий начинается с «привет», поэтому первый
// промпт как имя не годится: пять свежих сессий подряд выглядят одинаково. Берём первый
// СОДЕРЖАТЕЛЬНЫЙ, а короткий оставляем запасным вариантом — пустая кнопка хуже плохой.
const SNIPPET_MIN_CHARS = 25
// Врезки, которые пишет не человек: их видно в начале продолженных и консольных сессий.
const SNIPPET_BOILERPLATE = [/^Caveat:/i, /^This session is being continued/i, /^\[Request interrupted/i]

/** Первый содержательный и первый любой пользовательский текст из кусочка транскрипта. */
export function pickUserSnippet(lines: string[]): { meaningful?: string; first?: string } {
  let first: string | undefined
  for (const line of lines) {
    let parsed: { type?: string; message?: { content?: string | Array<{ type?: string; text?: string }> } }
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // хвост куска обрывается на середине строки — дочитается следующим
    }
    if (parsed.type !== 'user') {
      continue
    }
    const content = parsed.message?.content
    const raw = typeof content === 'string' ? content : (content?.find(p => p.type === 'text')?.text ?? '')
    // теги канала и служебные врезки оборачивают настоящий текст — на подпись идёт только он
    const text = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!text) {
      continue
    }
    first ??= text
    if (text.length >= SNIPPET_MIN_CHARS && !SNIPPET_BOILERPLATE.some(re => re.test(text))) {
      return { meaningful: text, first }
    }
  }
  return first === undefined ? {} : { first }
}

// Читаем ГОЛОВУ файла кусками, а не целиком: транскрипты бывают по сотне мегабайт. Первый
// промпт лежит в среднем на 50 КБ (спереди блок вложений с CLAUDE.md и хуками), но у 5% сессий
// глубже 60 КБ — на прежнем окне в 64 КБ каждая двадцатая кнопка оставалась без подписи.
const SNIPPET_CHUNK_BYTES = 256 * 1024
const SNIPPET_MAX_BYTES = 1024 * 1024

function firstUserText(dir: string, id: string): string {
  let fd: number | undefined
  try {
    fd = openSync(join(claudeProjectDir(dir), `${id}.jsonl`), 'r')
    // Кусок может разрезать UTF-8 посередине символа — декодер держит хвост между чтениями.
    const decoder = new StringDecoder('utf8')
    const buf = Buffer.alloc(SNIPPET_CHUNK_BYTES)
    let pending = ''
    let fallback: string | undefined
    for (let offset = 0; offset < SNIPPET_MAX_BYTES; offset += SNIPPET_CHUNK_BYTES) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n === 0) {
        break
      }
      const lines = (pending + decoder.write(buf.subarray(0, n))).split('\n')
      pending = lines.pop() ?? ''
      const picked = pickUserSnippet(lines)
      if (picked.meaningful) {
        return picked.meaningful
      }
      fallback ??= picked.first
      if (n < buf.length) {
        break
      }
    }
    return pickUserSnippet([pending]).meaningful ?? fallback ?? pickUserSnippet([pending]).first ?? ''
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

// Which transcript belongs to a binding. `sessionId` (from bindings.json) wins: several topics
// commonly bind the SAME project dir, so "newest file in dir" is another topic's conversation as
// often as not — that leaked one topic's answer into another. Newest is only the fallback for a
// binding that has no session id yet (never launched / not yet learned from a hook).
function transcriptId(dir: string, sessionId?: string): { id: string; mtime: number } | undefined {
  const mtimes = jsonlMtimes(dir)
  if (sessionId) {
    const mtime = mtimes.get(sessionId)
    if (mtime !== undefined) {
      return { id: sessionId, mtime }
    }
  }
  const newest = [...mtimes.entries()].sort((a, b) => b[1] - a[1])[0]
  return newest ? { id: newest[0], mtime: newest[1] } : undefined
}

export type RecentSession = { id: string; mtime: number; snippet: string }

export function recentSessions(dir: string, limit = 5): RecentSession[] {
  return [...jsonlMtimes(dir).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, mtime]) => ({ id, mtime, snippet: firstUserText(dir, id) }))
}

// Final assistant text of the most-recently-written session in `dir`, for the reply
// fallback (hub.ts). Reads only the file tail — transcripts run to many MB. Returns ''
// unless the newest session was written this turn (mtime and the message's own timestamp
// both ≥ sinceMs), so a turn that produced only tool calls never re-forwards a stale
// answer from an earlier turn.
// Byte size of the most-recently-written session file in `dir`. The reply fallback polls
// this until it stops growing — a filesystem-agnostic "the turn finished flushing" signal
// (size is exact even where mtime resolution is coarse), so it reads the turn's real final
// text instead of an intermediate preamble that happens to be on disk mid-flush.
export function newestJsonlSize(dir: string, sessionId?: string): number {
  const newest = transcriptId(dir, sessionId)
  if (!newest) {
    return 0
  }
  try {
    return statSync(join(claudeProjectDir(dir), `${newest.id}.jsonl`)).size
  } catch {
    return 0
  }
}

export function lastAssistantText(dir: string, sinceMs: number, sessionId?: string): string {
  const newest = transcriptId(dir, sessionId)
  // mtime is only a cheap "was this file touched around the turn" pre-filter — filesystems
  // truncate it (often to whole seconds), so allow 2s of slack. The per-message timestamp
  // below is the authoritative staleness guard.
  if (!newest || newest.mtime < sinceMs - 2000) {
    return ''
  }
  let buf: string
  try {
    const p = join(claudeProjectDir(dir), `${newest.id}.jsonl`)
    const size = statSync(p).size
    const start = Math.max(0, size - 262144) // last 256KB holds the turn's final message
    const fd = openSync(p, 'r')
    const b = Buffer.alloc(size - start)
    readSync(fd, b, 0, b.length, start)
    closeSync(fd)
    buf = b.toString('utf8')
  } catch {
    return ''
  }
  const lines = buf.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) {
      continue
    }
    let j: {
      type?: string
      timestamp?: string
      message?: { content?: Array<{ type?: string; text?: string }> }
    }
    try {
      j = JSON.parse(line)
    } catch {
      continue // a head line sliced mid-JSON by the tail read — skip it
    }
    if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) {
      continue
    }
    const text = j.message.content
      .filter(p => p.type === 'text' && p.text?.trim())
      .map(p => p.text)
      .join('\n\n')
      .trim()
    if (!text) {
      continue // tool-only assistant turn — keep scanning back for the last text block
    }
    // first (=latest) assistant text found; if it predates this turn there was no fresh answer
    return j.timestamp && Date.parse(j.timestamp) < sinceMs ? '' : text
  }
  return ''
}

// Did our inbound actually LAND in a session? The transcript is the ack the socket doesn't give
// us: `send()` into a closed or not-yet-listening stub is silent, and a lost message looked
// exactly like a working one until the user complained.
//
// It lands in one of two shapes, and BOTH count. Arriving into an idle session it becomes a
// `user` entry. Arriving mid-turn it is queued instead, and Claude Code logs that as
// `queue-operation`/`enqueue` with the text at the top level — the `user` entry appears only
// when the turn ends, minutes later. Watching for `user` alone declared every message sent to a
// busy session lost, resent it, and told the user it never arrived, while the agent was
// answering it.
// Scans every session file in `dir` touched since `sinceMs` — several topics share a dir, and the
// newest file isn't necessarily ours. Empty needle = "any inbound", for media-only messages.
export function transcriptSawIncoming(dir: string, sinceMs: number, needle: string): boolean {
  for (const [id, mtime] of jsonlMtimes(dir)) {
    if (mtime < sinceMs - 2000) {
      continue // untouched since we sent — can't hold our message
    }
    let buf: string
    try {
      const p = join(claudeProjectDir(dir), `${id}.jsonl`)
      const size = statSync(p).size
      const start = Math.max(0, size - 262144)
      const fd = openSync(p, 'r')
      const b = Buffer.alloc(size - start)
      readSync(fd, b, 0, b.length, start)
      closeSync(fd)
      buf = b.toString('utf8')
    } catch {
      continue
    }
    for (const line of buf.split('\n')) {
      if (!line.trim() || (!line.includes('"user"') && !line.includes('"queue-operation"'))) {
        continue
      }
      let j: { type?: string; timestamp?: string; content?: unknown; message?: { content?: unknown } }
      try {
        j = JSON.parse(line)
      } catch {
        continue // tail read sliced a line mid-JSON
      }
      if (j.type !== 'user' && j.type !== 'queue-operation') {
        continue
      }
      if (!j.timestamp || Date.parse(j.timestamp) < sinceMs - 2000) {
        continue
      }
      const raw = j.type === 'queue-operation' ? j.content : j.message?.content
      const content = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
      if (!needle || content.includes(needle)) {
        return true
      }
    }
  }
  return false
}

export async function captureNewSessionId(
  dir: string,
  before: Map<string, number>,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // Only a file ABSENT from the snapshot counts as new — an mtime bump on an
    // already-known id is just unrelated activity in a pre-existing session that
    // happens to share this dir (mode: folder), not evidence of a new one.
    for (const id of jsonlMtimes(dir).keys()) {
      if (!before.has(id)) {
        return id
      }
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  return undefined
}
