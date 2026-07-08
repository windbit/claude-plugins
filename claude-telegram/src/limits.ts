// Rate limits (5h/7d) and context fill come from the statusline dump
// (the statusline wrapper writes its stdin JSON here) — nowhere else exposes them.
import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { safeJsonParse } from './util'

const LIMITS_DIR = join(homedir(), '.claude', 'channels', 'telegram', 'limits')
const STALE_LIMITS_MS = 5 * 60 * 1000

export type Limits = {
  contextPct?: number
  fiveHourPct?: number
  fiveHourResetsAt?: number
  sevenDayPct?: number
  sevenDayResetsAt?: number
  ageMs: number
}

export function readLimits(dir: string, now = Date.now()): Limits | undefined {
  const file = join(LIMITS_DIR, dir.replace(/\//g, '-') + '.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined // no session dump yet
  }
  const d = safeJsonParse<any>(raw)
  if (!d) {
    return undefined
  }
  return {
    contextPct: d.context_window?.used_percentage,
    fiveHourPct: d.rate_limits?.five_hour?.used_percentage,
    fiveHourResetsAt: d.rate_limits?.five_hour?.resets_at,
    sevenDayPct: d.rate_limits?.seven_day?.used_percentage,
    sevenDayResetsAt: d.rate_limits?.seven_day?.resets_at,
    ageMs: now - statSync(file).mtimeMs,
  }
}

export function fmtDuration(secs: number): string {
  if (secs <= 0) {
    return '0m'
  }
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) {
    return `${d}d${h}h`
  }
  if (h > 0) {
    return `${h}h${String(m).padStart(2, '0')}m`
  }
  return `${m}m`
}

export function fmtUntil(resetsAtSec: number, nowMs: number): string {
  return fmtDuration(resetsAtSec - Math.floor(nowMs / 1000))
}

export function formatLimits(l: Limits, nowMs: number): string[] {
  const parts: string[] = []
  if (l.contextPct != null) {
    parts.push(`context ${l.contextPct}%`)
  }
  if (l.fiveHourPct != null) {
    const reset = l.fiveHourResetsAt != null ? `, resets ${fmtUntil(l.fiveHourResetsAt, nowMs)}` : ''
    parts.push(`5h ${l.fiveHourPct}%${reset}`)
  }
  if (l.sevenDayPct != null) {
    const reset = l.sevenDayResetsAt != null ? `, resets ${fmtUntil(l.sevenDayResetsAt, nowMs)}` : ''
    parts.push(`7d ${l.sevenDayPct}%${reset}`)
  }
  if (parts.length === 0) {
    return []
  }
  const stale = l.ageMs > STALE_LIMITS_MS ? ` (${fmtDuration(Math.floor(l.ageMs / 1000))} old)` : ''
  return [parts.join(' · ') + stale]
}
