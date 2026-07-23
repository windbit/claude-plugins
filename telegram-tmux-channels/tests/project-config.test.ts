import { describe, expect, test } from 'bun:test'
import { parseStandLinks, standLogTail } from '../src/project-config'

describe('parseStandLinks', () => {
  test('вытаскивает internal/external из любого места вывода, регистронезависимо', () => {
    const out = 'starting stand…\nEXTERNAL = https://console-1.lab.windbit.dev\nready\ninternal=http://console-1.localhost:8080\n'
    expect(parseStandLinks(out)).toEqual({
      external: 'https://console-1.lab.windbit.dev',
      internal: 'http://console-1.localhost:8080',
    })
  })
  test('нет ссылок → пустой объект', () => {
    expect(parseStandLinks('just logs\nno urls here')).toEqual({})
  })
})

describe('standLogTail', () => {
  test('строки-ссылки выкинуты, хвост обрезан', () => {
    const out = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\ninternal=http://x'
    const tail = standLogTail(out, '', 5)
    expect(tail.split('\n')).toHaveLength(5)
    expect(tail).not.toContain('internal=')
    expect(tail).toContain('line 19')
  })
  test('склеивает stdout+stderr, дропает пустые', () => {
    expect(standLogTail('out line\n\n', 'err line', 10)).toBe('out line\nerr line')
  })
})
