import type { Picker } from './picker'

export type PickAction = { kind: 'opt'; index: number } | { kind: 'submit' } | { kind: 'custom' }

export function buildKeyboard(
  picker: Picker,
  token: string,
  checked: number[],
): { text: string; buttons: { text: string; data: string }[][] } {
  const checkedSet = new Set(checked)
  const buttons: { text: string; data: string }[][] = []
  for (const opt of picker.options) {
    if (opt.index === picker.customIndex) {
      continue
    }
    const mark = picker.mode === 'multi' ? (checkedSet.has(opt.index) ? '☑ ' : '☐ ') : ''
    buttons.push([{ text: `${mark}${opt.label}`, data: `pk:${token}:o${opt.index}` }])
  }
  const tail: { text: string; data: string }[] = []
  if (picker.customIndex != null) {
    tail.push({ text: '✍️ Свой вариант', data: `pk:${token}:c` })
  }
  if (picker.mode === 'multi') {
    tail.push({ text: '✅ Submit', data: `pk:${token}:s` })
  }
  if (tail.length > 0) {
    buttons.push(tail)
  }
  return { text: picker.title || 'Выбор:', buttons }
}

export function parseCallback(data: string): { token: string; action: PickAction } | undefined {
  const m = /^pk:([0-9a-f]{6,16}):(o\d+|s|c)$/.exec(data)
  if (!m) {
    return undefined
  }
  const [, token, a] = m
  if (a === 's') {
    return { token, action: { kind: 'submit' } }
  }
  if (a === 'c') {
    return { token, action: { kind: 'custom' } }
  }
  return { token, action: { kind: 'opt', index: Number(a.slice(1)) } }
}
