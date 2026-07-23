// bindings.json — the hub's key → project map: {"-100.../42": {dir, allow?, cmdline?}}.
// Driven by /bind,/unbind,/allow from Telegram; also hand-editable (hot-reloaded).
import { readFileSync, writeFileSync, renameSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { STATE_DIR } from './paths'
import { safeJsonParse } from './util'

export const BINDINGS_FILE = join(STATE_DIR, 'bindings.json')

export type BindingEntry = {
  dir: string
  allow?: string[]
  cmdline?: string[]
  sessionId?: string // claude conversation id — --resume target when this binding's dir is shared
  hookBranch?: string // set for auto-topic worktree bindings created via a group hook — /unbind runs hook.delete on this
  pinned?: boolean // /pin — never idle-unload this binding (see TELEGRAM_IDLE_UNLOAD_MINUTES)
}

export function loadBindings(): Record<string, BindingEntry> {
  let raw: string
  try {
    raw = readFileSync(BINDINGS_FILE, 'utf8')
  } catch {
    return {} // no bindings file yet
  }
  return safeJsonParse<Record<string, BindingEntry>>(raw) ?? {}
}

export function saveBindings(reg: Record<string, BindingEntry>): void {
  writeFileSync(BINDINGS_FILE + '.tmp', JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
  renameSync(BINDINGS_FILE + '.tmp', BINDINGS_FILE)
}

export function keysForDir(reg: Record<string, BindingEntry>, dir: string): string[] {
  return Object.keys(reg).filter(k => reg[k].dir === dir)
}

// "/bind myapp" → ~/projects/myapp; also accepts an absolute path or ~/…
export function resolveProjectDir(arg: string, projectsRoot = join(homedir(), 'projects')): string {
  const p = arg.startsWith('~/') ? join(homedir(), arg.slice(2)) : arg
  const full = p.startsWith('/') ? p : join(projectsRoot, p)
  if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`not a directory: ${full}`)
  }
  return full
}
