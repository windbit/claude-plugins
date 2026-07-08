// Claude stores each conversation as ~/.claude/projects/<slug>/<session-id>.jsonl.
// The hub isn't told the id directly — it snapshots that dir before a fresh launch
// and polls for the new file afterward, same slug rule Claude Code itself uses.
import { readdirSync, statSync } from 'fs'
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
