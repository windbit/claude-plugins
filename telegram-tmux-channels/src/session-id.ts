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
