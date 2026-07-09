// Parser for Claude Code's interactive TUI pickers captured from tmux capture-pane.
// Grounded on real /model and AskUserQuestion renders — see tests/fixtures.

const OPTION_RE = /^\s*❯?\s*(\d+)\.\s+(.*)$/
const CHECKBOX_RE = /^\[[ ✔xX]\]\s*/
const CUSTOM_RE = /type something|other|custom|свой|own/i
const FOOTER = 'Esc to cancel'

export type PickerOption = { index: number; label: string }
export type Picker = {
  title: string
  options: PickerOption[]
  mode: 'single' | 'multi'
  customIndex?: number
  hash: string
}

const MAX_TITLE_LINES = 3
// A live picker owns the input area; a leftover footer higher up has the real chat
// input box (a bare ❯ prompt, no option text) below it — that's the staleness tell.
// Anything else below (delivered-message echoes, a background task widget) is just
// chrome and doesn't mean the picker resolved.
const BARE_PROMPT_RE = /^❯\s*$/

function hasLiveInputBelow(lines: string[], footerIdx: number): boolean {
  for (let i = footerIdx + 1; i < lines.length; i++) {
    if (BARE_PROMPT_RE.test(lines[i].trim())) {
      return true
    }
  }
  return false
}

function optionLabel(rest: string): string {
  const noCheckbox = rest.replace(CHECKBOX_RE, '')
  const beforeDesc = noCheckbox.split(/\s{2,}/)[0] // inline description sits after 2+ spaces
  return beforeDesc.replace(/\s*✔\s*$/, '').trim()
}

function isSeparator(t: string): boolean {
  return /^[─▔━]+$/.test(t)
}

// UI chrome inside a picker box (not a separator — those are handled by the scan):
// blanks, the ●-sub-control, and the header chip (`☐ Word` / multi `← ☐ … Submit →`).
function isChrome(t: string): boolean {
  if (!t) {
    return true
  }
  if (/^●/.test(t)) {
    return true
  }
  if (/^[☐☒]/.test(t)) {
    return true
  }
  if (t.startsWith('←') && (t.includes('Submit') || t.includes('→'))) {
    return true
  }
  return false
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// Parse only the picker box: scan UPWARD from the footer, collecting the option
// block and (up to MAX_TITLE_LINES of) the title above it. Content further up the
// screen (scrollback, prior agent output with its own numbered lists) is ignored.
export function parsePicker(text: string): Picker | undefined {
  const lines = text.split('\n')
  let lastIdx = lines.length - 1
  while (lastIdx >= 0 && !lines[lastIdx].trim()) {
    lastIdx--
  }
  let footerIdx = -1
  for (let i = lastIdx; i >= 0; i--) {
    if (lines[i].includes(FOOTER)) {
      footerIdx = i
      break
    }
  }
  if (footerIdx < 0 || hasLiveInputBelow(lines, footerIdx)) {
    return undefined
  }
  const options: PickerOption[] = []
  let titleParts: string[] = []
  let titleStarted = false
  let multi = false
  for (let i = footerIdx - 1; i >= 0; i--) {
    const t = lines[i].trim()
    const m = OPTION_RE.exec(lines[i])
    if (m) {
      if (CHECKBOX_RE.test(m[2])) {
        multi = true
      }
      options.unshift({ index: Number(m[1]), label: optionLabel(m[2]) })
      titleParts = [] // an option above resets the title — descriptions between options aren't it
      titleStarted = false
      continue
    }
    if (isSeparator(t)) {
      if (titleStarted) {
        break // separator above the title = top of the picker box; stop before scrollback
      }
      continue // separator between options is internal
    }
    if (isChrome(t)) {
      continue
    }
    if (options.length === 0) {
      continue
    }
    titleStarted = true
    titleParts.unshift(t)
    if (titleParts.length >= MAX_TITLE_LINES) {
      break
    }
  }
  if (options.length < 2) {
    return undefined
  }
  const custom = options.find(o => CUSTOM_RE.test(o.label))
  const title = titleParts.join(' ').trim()
  return {
    title,
    options,
    mode: multi ? 'multi' : 'single',
    ...(custom ? { customIndex: custom.index } : {}),
    hash: fnv1a(title + '|' + options.map(o => `${o.index}:${o.label}`).join('|')),
  }
}

export function checkedIndexes(text: string): number[] {
  const out: number[] = []
  for (const line of text.split('\n')) {
    const m = OPTION_RE.exec(line)
    if (m && /^\[[✔xX]\]/.test(m[2])) {
      out.push(Number(m[1]))
    }
  }
  return out
}
