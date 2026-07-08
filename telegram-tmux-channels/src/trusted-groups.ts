// trusted-groups.json — chat_id → auto-topic config. Hand-editable, like bindings.json.
import { readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './paths'
import { safeJsonParse } from './util'

export const TRUSTED_GROUPS_FILE = join(STATE_DIR, 'trusted-groups.json')

export type TrustedGroupMode = 'shared' | 'worktree' | 'hook'

export type TrustedGroupConfig = {
  mode: TrustedGroupMode
  dir: string
  hook?: string
  cmdline?: string[]
  exclude?: { topicIds?: number[]; nameContains?: string[] }
}

export function loadTrustedGroups(): Record<string, TrustedGroupConfig> {
  let raw: string
  try {
    raw = readFileSync(TRUSTED_GROUPS_FILE, 'utf8')
  } catch {
    return {}
  }
  return safeJsonParse<Record<string, TrustedGroupConfig>>(raw) ?? {}
}

export function isExcludedTopic(cfg: TrustedGroupConfig, topicId: number, topicName: string): boolean {
  if (cfg.exclude?.topicIds?.includes(topicId)) {
    return true
  }
  return cfg.exclude?.nameContains?.some(s => topicName.includes(s)) ?? false
}

// topic title → branch/worktree slug, same rule as agentek-console's wt.py: unsafe chars → "-"
export function slugFromTopicName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9/_.]+/g, '-').replace(/^-+|-+$/g, '') || 'topic'
}
