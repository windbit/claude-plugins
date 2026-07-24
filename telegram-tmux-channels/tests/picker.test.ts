import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parsePicker, checkedIndexes, parseResumeList } from '../src/picker'

const fx = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')

describe('parsePicker', () => {
  test('single /model: options, mode, no custom', () => {
    const p = parsePicker(fx('model-single.txt'))!
    expect(p.mode).toBe('single')
    expect(p.options.map(o => o.index)).toEqual([1, 2, 3, 4, 5])
    expect(p.options[3].label).toBe('Sonnet')
    expect(p.customIndex).toBeUndefined()
  })
  test('single AskUserQuestion: label without description, custom=Type something', () => {
    const p = parsePicker(fx('ask-single.txt'))!
    expect(p.mode).toBe('single')
    expect(p.title).toContain('Tea or coffee?')
    expect(p.options).toEqual([
      { index: 1, label: 'Tea' },
      { index: 2, label: 'Coffee' },
      { index: 3, label: 'Type something.' },
      { index: 4, label: 'Chat about this' },
    ])
    expect(p.customIndex).toBe(3)
  })
  test('multi: checkboxes → mode multi, label without [ ]', () => {
    const p = parsePicker(fx('ask-multi.txt'))!
    expect(p.mode).toBe('multi')
    expect(p.options[0]).toEqual({ index: 1, label: 'Python' })
    expect(p.customIndex).toBe(4)
  })
  test('plain text without a picker → undefined', () => {
    expect(parsePicker('just a prompt\n❯ \n')).toBeUndefined()
  })
  test('stale footer: leftover «Esc to cancel» with a prompt box under it → not a picker', () => {
    expect(parsePicker(fx('stale-footer.txt'))).toBeUndefined()
  })
  test('live picker + foreign trailing chrome (echoed telegram messages, task widget) under the footer → still a picker', () => {
    const p = parsePicker(fx('live-with-trailing-chrome.txt'))!
    expect(p.options.map(o => o.label)).toEqual(['Back to text', 'Keep voice as is', 'Type something.', 'Chat about this'])
  })
  test('scrollback: a numbered list ABOVE the picker does not leak into options/title', () => {
    const p = parsePicker(fx('scrollback-noise.txt'))!
    expect(p.options.map(o => o.label)).toEqual(['Migrate', 'Roll back', 'Type something.'])
    expect(p.title).toBe("What's the next step?")
    expect(p.title).not.toContain('back up')
  })
  test('hash is stable and distinguishes pickers', () => {
    expect(parsePicker(fx('ask-single.txt'))!.hash).toBe(parsePicker(fx('ask-single.txt'))!.hash)
    expect(parsePicker(fx('ask-single.txt'))!.hash).not.toBe(parsePicker(fx('ask-multi.txt'))!.hash)
  })
})

describe('checkedIndexes', () => {
  test('reads [✔] from multi', () => {
    expect(checkedIndexes(fx('ask-multi.txt'))).toEqual([2])
  })
  test('single without checkboxes → []', () => {
    expect(checkedIndexes(fx('ask-single.txt'))).toEqual([])
  })
})

describe('parseResumeList', () => {
  test('real /resume snapshot: rows, cursor, total', () => {
    const l = parseResumeList(fx('resume-list.txt'))!
    expect(l.total).toBe('1 of 27')
    expect(l.cursor).toBe(0)
    expect(l.rows.map(r => r.title)).toEqual([
      '(session)',
      'commit changes in homelab and the plugin',
      'Remind me of the last two days of work',
      'Set up Telegram binding for Claude server',
    ])
    expect(l.rows[1].meta).toBe('1 day ago · main · 6.9MB')
  })
  test('plain screen without a list → undefined', () => {
    expect(parseResumeList(fx('model-single.txt'))).toBeUndefined()
    expect(parseResumeList('')).toBeUndefined()
  })
})
