import { describe, expect, test } from 'bun:test'
import { modeButtons } from '../src/mode-picker'

const opts = (over: Partial<Parameters<typeof modeButtons>[0]> = {}) => modeButtons({
  key: '-100/7', modes: ['folder', 'worktree'], bases: ['dev', 'master'],
  hooked: true, hookOff: false, harness: 'Claude Code', ...over,
})

describe('пикер режима нового топика', () => {
  test('хук — переключатель, а не вторая кнопка на каждую базу', () => {
    const rows = opts()
    expect(rows.map(r => r.data)).toEqual([
      'topicharness:-100/7',
      'topichook:-100/7',
      'topicmode:-100/7:folder',
      'topicmode:-100/7:worktree:0',
      'topicmode:-100/7:worktree:1',
      'topicdir:-100/7',
    ])
    expect(rows.filter(r => r.text.includes('worktree from'))).toHaveLength(2)
  })

  test('выключенный хук меняет режим кнопок баз, а не их число', () => {
    const off = opts({ hookOff: true })
    expect(off.filter(r => r.data.includes(':worktree-plain:'))).toHaveLength(2)
    expect(off).toHaveLength(opts().length)
    // подпись переключателя показывает ТЕКУЩЕЕ положение, как у харнесса
    expect(off[1]!.text).not.toBe(opts()[1]!.text)
  })

  test('нет хука у проекта — нет и переключателя, режим остаётся обычным', () => {
    const rows = opts({ hooked: false, hookOff: true })
    expect(rows.some(r => r.data.startsWith('topichook:'))).toBe(false)
    expect(rows.some(r => r.data.includes('worktree-plain'))).toBe(false)
  })

  test('одна база — одна кнопка worktree без индекса базы', () => {
    const rows = opts({ bases: ['dev'] })
    expect(rows.map(r => r.data)).toContain('topicmode:-100/7:worktree')
    expect(rows.some(r => /:worktree:\d+$/.test(r.data))).toBe(false)
  })

  test('один харнесс — переключателя харнесса нет', () => {
    const rows = modeButtons({ key: 'k', modes: ['worktree'], bases: [], hooked: false, hookOff: false })
    expect(rows.map(r => r.data)).toEqual(['topicmode:k:worktree', 'topicdir:k'])
  })
})
