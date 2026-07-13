// trusted-groups.json — chat_id → auto-topic config. Hand-editable, like bindings.json.
import { readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './paths'
import { safeJsonParse } from './util'

export const TRUSTED_GROUPS_FILE = join(STATE_DIR, 'trusted-groups.json')

export type TrustedGroupMode = 'folder' | 'worktree'

// optional worktree-mode customization: shell command templates ({branch}/{dir}
// substituted, run via `sh -c`) that replace `git worktree add`/`remove` — e.g. a
// wrapper that also provisions a per-branch DB. No hook configured → plain git worktree.
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

// Cyrillic → Latin, common web scheme. The slug becomes a git branch name (and,
// via the worktree dir, a tmux session name) — non-ASCII there is a real foot-gun
// (tool/shell/filesystem compat), so transliterate rather than pass it through raw.
const CYRILLIC_TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
}

function transliterate(name: string): string {
  return [...name]
    .map(ch => {
      const lower = ch.toLowerCase()
      const t = CYRILLIC_TRANSLIT[lower]
      if (t === undefined) {
        return ch
      }
      return ch === lower ? t : t.charAt(0).toUpperCase() + t.slice(1)
    })
    .join('')
}

// topic title → branch/worktree slug — transliterated, then only genuinely safe
// chars kept (everything else collapses to a dash).
export function slugFromTopicName(name: string): string {
  return transliterate(name.trim()).replace(/[^\p{L}\p{N}/_.-]+/gu, '-').replace(/^-+|-+$/g, '') || 'topic'
}
