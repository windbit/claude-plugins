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

function optionLabel(rest: string): string {
  const noCheckbox = rest.replace(CHECKBOX_RE, '')
  const beforeDesc = noCheckbox.split(/\s{2,}/)[0] // inline description sits after 2+ spaces
  return beforeDesc.replace(/\s*✔\s*$/, '').trim()
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function parsePicker(text: string): Picker | undefined {
  if (!text.includes(FOOTER)) {
    return undefined
  }
  const options: PickerOption[] = []
  const titleLines: string[] = []
  let multi = false
  let seenOption = false
  for (const line of text.split('\n')) {
    const m = OPTION_RE.exec(line)
    if (m) {
      seenOption = true
      if (CHECKBOX_RE.test(m[2])) {
        multi = true
      }
      options.push({ index: Number(m[1]), label: optionLabel(m[2]) })
      continue
    }
    if (!seenOption && line.trim() && !line.includes('☐') && !line.includes('Submit')) {
      titleLines.push(line.trim())
    }
  }
  if (options.length < 2) {
    return undefined
  }
  const custom = options.find(o => CUSTOM_RE.test(o.label))
  const title = titleLines.join(' ').trim()
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
