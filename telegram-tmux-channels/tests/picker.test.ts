import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parsePicker, checkedIndexes } from '../src/picker'

const fx = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')

describe('parsePicker', () => {
  test('single /model: опции, режим, без custom', () => {
    const p = parsePicker(fx('model-single.txt'))!
    expect(p.mode).toBe('single')
    expect(p.options.map(o => o.index)).toEqual([1, 2, 3, 4, 5])
    expect(p.options[3].label).toBe('Sonnet')
    expect(p.customIndex).toBeUndefined()
  })
  test('single AskUserQuestion: label без описания, custom=Type something', () => {
    const p = parsePicker(fx('ask-single.txt'))!
    expect(p.mode).toBe('single')
    expect(p.title).toContain('Чай или кофе?')
    expect(p.options).toEqual([
      { index: 1, label: 'Чай' },
      { index: 2, label: 'Кофе' },
      { index: 3, label: 'Type something.' },
      { index: 4, label: 'Chat about this' },
    ])
    expect(p.customIndex).toBe(3)
  })
  test('multi: чекбоксы → mode multi, label без [ ]', () => {
    const p = parsePicker(fx('ask-multi.txt'))!
    expect(p.mode).toBe('multi')
    expect(p.options[0]).toEqual({ index: 1, label: 'Python' })
    expect(p.customIndex).toBe(4)
  })
  test('обычный текст без пикера → undefined', () => {
    expect(parsePicker('just a prompt\n❯ \n')).toBeUndefined()
  })
  test('stale footer: остаток «Esc to cancel» с промпт-боксом под ним → не пикер', () => {
    expect(parsePicker(fx('stale-footer.txt'))).toBeUndefined()
  })
  test('live picker + чужой хвост (эхо телеграм-сообщений, task-виджет) под футером → всё ещё пикер', () => {
    const p = parsePicker(fx('live-with-trailing-chrome.txt'))!
    expect(p.options.map(o => o.label)).toEqual(['Вернуться к тексту', 'Оставить голосовые как есть', 'Type something.', 'Chat about this'])
  })
  test('scrollback: нумерованный список ВЫШЕ пикера не попадает в опции/заголовок', () => {
    const p = parsePicker(fx('scrollback-noise.txt'))!
    expect(p.options.map(o => o.label)).toEqual(['Мигрировать', 'Откатить', 'Type something.'])
    expect(p.title).toBe('Какой следующий шаг?')
    expect(p.title).not.toContain('бэкап')
  })
  test('хэш стабилен и различает пикеры', () => {
    expect(parsePicker(fx('ask-single.txt'))!.hash).toBe(parsePicker(fx('ask-single.txt'))!.hash)
    expect(parsePicker(fx('ask-single.txt'))!.hash).not.toBe(parsePicker(fx('ask-multi.txt'))!.hash)
  })
})

describe('checkedIndexes', () => {
  test('читает [✔] из multi', () => {
    expect(checkedIndexes(fx('ask-multi.txt'))).toEqual([2])
  })
  test('single без чекбоксов → []', () => {
    expect(checkedIndexes(fx('ask-single.txt'))).toEqual([])
  })
})
