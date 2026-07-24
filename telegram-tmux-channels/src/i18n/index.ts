// UI language — GLOBAL (one setting for the whole hub), switchable at runtime via /lang.
// `en` is the canonical table; `ru` is typed against it (typeof en) so the compiler flags
// any missing/mismatched key. Dynamic parts are escaped by call sites, not here — template
// fns just interpolate, so pass already-escHtml'd values in.
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../paths'
import { en } from './en'
import { ru } from './ru'

export type Lang = 'en' | 'ru'
export type Strings = typeof en

const TABLES: Record<Lang, Strings> = { en, ru }
const LANG_FILE = join(STATE_DIR, 'lang') // persists the runtime /lang choice across restarts

function initialLang(): Lang {
  try {
    const v = readFileSync(LANG_FILE, 'utf8').trim()
    if (v === 'ru' || v === 'en') {
      return v
    }
  } catch {
    // no saved choice yet
  }
  return process.env.TELEGRAM_LANG === 'ru' ? 'ru' : 'en' // default English
}

let current: Lang = initialLang()

export function getLang(): Lang {
  return current
}

export function setLang(l: Lang): void {
  current = l
  try {
    writeFileSync(LANG_FILE, l + '\n', { mode: 0o600 })
  } catch {
    // best-effort persistence; in-memory switch still takes effect
  }
}

// Current global string table. Call at use time (language is mutable) — don't cache at module load.
export function t(): Strings {
  return TABLES[current]
}
