import { describe, expect, test } from 'bun:test'
import { mergeTopic } from '../src/known-chats'

const t = (n: number) => new Date(n).toISOString()

describe('mergeTopic', () => {
  test('id-only sighting never clobbers a name learned from an update', () => {
    const seen = mergeTopic(undefined, undefined, t(1))! // plain message: id known, name not
    expect(seen.title).toBeUndefined()

    const named = mergeTopic(seen, 'Деплой', t(2))! // forum_topic_created/edited
    expect(named.title).toBe('Деплой')
    expect(named.firstSeen).toBe(t(1))

    expect(mergeTopic(named, undefined, t(3))).toBeUndefined() // another message → no write, name kept
    expect(mergeTopic(named, 'Деплой', t(3))).toBeUndefined() // same name → no write

    const renamed = mergeTopic(named, 'Деплой v2', t(4))!
    expect(renamed.title).toBe('Деплой v2')
    expect(renamed.firstSeen).toBe(t(1))
  })
})
