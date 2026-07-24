// `.tmux-channels.json` in a project's root — the per-project half of the hub's config
// (named after the plugin), next to the per-chat half in bindings.json. Hooks differ per repo
// (how to raise a stand, how to cut a worktree), so they live WITH the repo instead of in the
// hub's group config; a folder without the file simply has no stand commands.
//
// {
//   "stand": { "up": "…", "down": "…", "status": "…" },   // status: exit 0 = up
//   "worktree": { "create": "…", "delete": "…" }          // create prints the path on its last line
// }
import { readFileSync } from 'fs'
import { join } from 'path'
import { safeJsonParse } from './util'

export const PROJECT_CONFIG_FILE = '.tmux-channels.json'

export type StandConfig = { up?: string; down?: string; status?: string }
export type ProjectConfig = {
  stand?: StandConfig
  worktree?: { create: string; delete?: string }
}

export function loadProjectConfig(dir: string): ProjectConfig | undefined {
  let raw: string
  try {
    raw = readFileSync(join(dir, PROJECT_CONFIG_FILE), 'utf8')
  } catch {
    return undefined
  }
  return safeJsonParse<ProjectConfig>(raw)
}

// Stand links from the hook's output: `internal=…` / `external=…` lines anywhere in the output.
// Everything else is ordinary log, shown as a tail.
export type StandLinks = { internal?: string; external?: string }

export function parseStandLinks(out: string): StandLinks {
  const links: StandLinks = {}
  for (const line of out.split('\n')) {
    const m = /^\s*(internal|external)\s*=\s*(\S+)\s*$/i.exec(line)
    if (m) {
      links[m[1].toLowerCase() as keyof StandLinks] = m[2]
    }
  }
  return links
}

// Output tail for chat: without the link lines (already rendered separately) and without blanks.
export function standLogTail(out: string, err: string, maxLines = 12): string {
  const lines = `${out}\n${err}`
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l && !/^\s*(internal|external)\s*=/i.test(l))
  return lines.slice(-maxLines).join('\n')
}
