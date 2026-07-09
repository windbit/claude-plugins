// trusted-groups.json — chat_id → auto-topic config. Hand-editable, like bindings.json.
import { readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './paths'
import { safeJsonParse } from './util'

export const TRUSTED_GROUPS_FILE = join(STATE_DIR, 'trusted-groups.json')

export type TrustedGroupMode = 'folder' | 'worktree' | 'hook'

// shell command templates — {branch}/{dir} get substituted, run via `sh -c`
export type HookConfig = { create: string; delete?: string }

export type TrustedGroupConfig = {
  modes: TrustedGroupMode[] // 1 = auto, no picker; 2+ = per-topic button choice
  dir?: string // unset → ask for it per-topic, same as /bind
  hook?: HookConfig
  cmdline?: string[]
  exclude?: { topicIds?: number[]; nameContains?: string[] }
}

export const MODE_LABEL: Record<TrustedGroupMode, string> = {
  folder: '📁 Папка по умолчанию',
  worktree: '🌿 Worktree (своя git-ветка)',
  hook: '🪝 Hook',
}

const DEFAULT_MODES: TrustedGroupMode[] = ['folder']

type GroupDefaults = { modes?: TrustedGroupMode[]; cmdline?: string[]; dir?: string }
type GroupEntry = GroupDefaults & { hook?: HookConfig; exclude?: TrustedGroupConfig['exclude'] }
type TrustedGroupsFile = { defaults?: GroupDefaults; groups?: Record<string, GroupEntry> }

export function mergeGroupConfig(defaults: GroupDefaults | undefined, group: GroupEntry): TrustedGroupConfig {
  return {
    dir: group.dir ?? defaults?.dir,
    modes: group.modes ?? defaults?.modes ?? DEFAULT_MODES,
    cmdline: group.cmdline ?? defaults?.cmdline,
    hook: group.hook,
    exclude: group.exclude,
  }
}

export function loadTrustedGroups(): Record<string, TrustedGroupConfig> {
  let raw: string
  try {
    raw = readFileSync(TRUSTED_GROUPS_FILE, 'utf8')
  } catch {
    return {}
  }
  const file = safeJsonParse<TrustedGroupsFile>(raw)
  if (!file?.groups) {
    return {}
  }
  const out: Record<string, TrustedGroupConfig> = {}
  for (const [chatId, group] of Object.entries(file.groups)) {
    out[chatId] = mergeGroupConfig(file.defaults, group)
  }
  return out
}

export function isExcludedTopic(cfg: TrustedGroupConfig, topicId: number, topicName: string): boolean {
  if (cfg.exclude?.topicIds?.includes(topicId)) {
    return true
  }
  return cfg.exclude?.nameContains?.some(s => topicName.includes(s)) ?? false
}

// topic title → branch/worktree slug. Keep letters from any script (Cyrillic
// topic names are the common case here) — only collapse genuinely unsafe chars.
export function slugFromTopicName(name: string): string {
  return name.trim().replace(/[^\p{L}\p{N}/_.-]+/gu, '-').replace(/^-+|-+$/g, '') || 'topic'
}
