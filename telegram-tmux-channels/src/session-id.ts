// Claude stores each conversation as ~/.claude/projects/<slug>/<session-id>.jsonl.
// The hub isn't told the id directly — it snapshots that dir before a fresh launch
// and polls for the new file afterward, same slug rule Claude Code itself uses.
import { readdirSync, statSync, openSync, readSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

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

// First user text of a session, for resume-picker button labels. Reads only the
// head of the file — enough for a label, cheap on multi-MB transcripts.
function firstUserText(dir: string, id: string): string {
  try {
    const fd = openSync(join(claudeProjectDir(dir), `${id}.jsonl`), 'r')
    const buf = Buffer.alloc(65536)
    const n = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      try {
        const j = JSON.parse(line) as {
          type?: string
          message?: { content?: string | Array<{ type?: string; text?: string }> }
        }
        if (j.type !== 'user') {
          continue
        }
        const c = j.message?.content
        const raw = typeof c === 'string' ? c : (c?.find(p => p.type === 'text')?.text ?? '')
        // channel/system tags wrap real text — strip them for the label
        const text = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        if (text) {
          return text
        }
      } catch {}
    }
  } catch {}
  return ''
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
export function lastAssistantText(dir: string, sinceMs: number): string {
  const newest = [...jsonlMtimes(dir).entries()].sort((a, b) => b[1] - a[1])[0]
  if (!newest || newest[1] < sinceMs) {
    return ''
  }
  let buf: string
  try {
    const p = join(claudeProjectDir(dir), `${newest[0]}.jsonl`)
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
