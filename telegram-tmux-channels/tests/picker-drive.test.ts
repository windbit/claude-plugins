import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parsePicker } from '../src/picker'
import { buildKeyboard, parseCallback } from '../src/picker-drive'

const fx = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', n), 'utf8')

describe('buildKeyboard', () => {
  test('single: кнопка на опцию, custom отдельной кнопкой, без Submit', () => {
    const p = parsePicker(fx('ask-single.txt'))!
    const kb = buildKeyboard(p, 'ab12cd34', [])
    const flat = kb.buttons.flat()
    expect(flat.find(b => b.data === 'pk:ab12cd34:o1')?.text).toBe('Чай')
    expect(flat.some(b => b.data === 'pk:ab12cd34:c')).toBe(true)
    expect(flat.some(b => b.data === 'pk:ab12cd34:s')).toBe(false)
    expect(kb.text).toContain('Чай или кофе?')
  })
  test('multi: тоггл-лейблы из checked, есть Submit', () => {
    const p = parsePicker(fx('ask-multi.txt'))!
    const kb = buildKeyboard(p, 'dcab0000', [2])
    const flat = kb.buttons.flat()
    expect(flat.find(b => b.data === 'pk:dcab0000:o1')?.text).toBe('⬜ Python')
    expect(flat.find(b => b.data === 'pk:dcab0000:o2')?.text).toBe('✅ Go')
    expect(flat.some(b => b.data === 'pk:dcab0000:s')).toBe(true)
  })
})

describe('parseCallback', () => {
  test('opt/submit/custom; чужой data → undefined', () => {
    expect(parseCallback('pk:ab12cd34:o3')).toEqual({ token: 'ab12cd34', action: { kind: 'opt', index: 3 } })
    expect(parseCallback('pk:dcab0000:s')).toEqual({ token: 'dcab0000', action: { kind: 'submit' } })
    expect(parseCallback('pk:dcab0000:c')).toEqual({ token: 'dcab0000', action: { kind: 'custom' } })
    expect(parseCallback('perm:allow:abcde')).toBeUndefined()
  })
})
