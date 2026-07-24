import { describe, expect, test } from 'bun:test'
import { parseStandLinks, standLogTail } from '../src/project-config'

describe('parseStandLinks', () => {
  test('pulls internal/external from anywhere in the output, case-insensitively', () => {
    const out = 'starting stand…\nEXTERNAL = https://console-1.lab.windbit.dev\nready\ninternal=http://console-1.localhost:8080\n'
    expect(parseStandLinks(out)).toEqual({
      external: 'https://console-1.lab.windbit.dev',
      internal: 'http://console-1.localhost:8080',
    })
  })
  test('no links → empty object', () => {
    expect(parseStandLinks('just logs\nno urls here')).toEqual({})
  })
})

describe('standLogTail', () => {
  test('link lines dropped, tail trimmed', () => {
    const out = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\ninternal=http://x'
    const tail = standLogTail(out, '', 5)
    expect(tail.split('\n')).toHaveLength(5)
    expect(tail).not.toContain('internal=')
    expect(tail).toContain('line 19')
  })
  test('joins stdout+stderr, drops blanks', () => {
    expect(standLogTail('out line\n\n', 'err line', 10)).toBe('out line\nerr line')
  })
})
