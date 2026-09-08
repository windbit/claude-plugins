import { describe, expect, test } from 'bun:test'
import {
  candidateBlock, encodeEvent, foldJournal, parseJournal, resumeCandidates,
  type TopicEvent, type TopicRecord,
} from '../src/topic-journal'

const bound = (over: Partial<Extract<TopicEvent, { kind: 'bound' }>> = {}): TopicEvent => ({
  kind: 'bound', ts: 1000, key: '-100/7', chatId: '-100', dir: '/p/repo',
  title: 'Ekomobile', branch: 'ekomobayl', mode: 'worktree', agent: 'claude', ...over,
})

describe('журнал топиков', () => {
  test('битая строка не съедает историю', () => {
    const text = [encodeEvent(bound()), '{"kind":"bound","ts":', '\n', '{"junk":1}\n'].join('')
    expect(parseJournal(text)).toHaveLength(1)
  })

  test('запись без обязательных полей отбрасывается', () => {
    const text = '{"kind":"session","ts":5,"key":"-100/7"}\n{"kind":"bound","ts":5,"key":"-100/7","chatId":"-100"}\n'
    expect(parseJournal(text)).toEqual([])
  })

  test('свёртка берёт последнюю сессию топика, а не первую', () => {
    const rec = foldJournal([
      bound(),
      { kind: 'session', ts: 1100, key: '-100/7', sessionId: 'aaa' },
      { kind: 'session', ts: 1200, key: '-100/7', sessionId: 'bbb' },
    ])
    expect(rec).toHaveLength(1)
    expect(rec[0]!.sessionId).toBe('bbb')
    expect(rec[0]!.lastSeen).toBe(1200)
  })

  test('повторная привязка того же топика начинает жизнь заново', () => {
    const rec = foldJournal([
      bound({ dir: '/p/old', branch: 'old' }),
      { kind: 'session', ts: 1100, key: '-100/7', sessionId: 'aaa' },
      { kind: 'gone', ts: 1200, key: '-100/7', reason: 'delete', dirRemoved: true },
      bound({ ts: 1300, dir: '/p/new', branch: 'new' }),
    ])
    expect(rec[0]).toMatchObject({ dir: '/p/new', branch: 'new', status: 'live', dirRemoved: false })
    expect(rec[0]!.sessionId).toBeUndefined() // сессия старой жизни к новой папке не относится
  })

  test('снос топика помечает запись, но не удаляет её', () => {
    const rec = foldJournal([
      bound(),
      { kind: 'session', ts: 1100, key: '-100/7', sessionId: 'aaa' },
      { kind: 'gone', ts: 1200, key: '-100/7', reason: 'delete', dirRemoved: true },
    ])
    expect(rec[0]).toMatchObject({ status: 'deleted', dirRemoved: true, branch: 'ekomobayl' })
    expect(rec[0]!.sessionId).toBe('aaa') // вернуться в снесённый топик — ради этого журнал и нужен
  })

  test('событие без привязки (журнал обрезан ротацией) игнорируется', () => {
    expect(foldJournal([{ kind: 'session', ts: 5, key: '-100/9', sessionId: 'aaa' }])).toEqual([])
  })
})

describe('кандидаты на возврат', () => {
  const rec = (over: Partial<TopicRecord>): TopicRecord => ({
    key: '-100/7', chatId: '-100', dir: '/p/repo', sessionId: 'aaa',
    lastSeen: 1000, status: 'unbound', dirRemoved: false, ...over,
  })
  const filter = { chatId: '-100', now: 2000, maxAgeMs: 5000, limit: 10 }

  test('чужой чат в список не попадает', () => {
    const got = resumeCandidates([rec({}), rec({ key: '-200/1', chatId: '-200' })], filter)
    expect(got.map(r => r.key)).toEqual(['-100/7'])
  })

  test('без сессии возвращаться некуда', () => {
    expect(resumeCandidates([rec({ sessionId: undefined })], filter)).toEqual([])
  })

  test('живой биндинг не предлагаем — он и так на месте', () => {
    expect(resumeCandidates([rec({})], { ...filter, liveKeys: ['-100/7'] })).toEqual([])
  })

  test('старьё отсекается порогом, свежее идёт первым', () => {
    const got = resumeCandidates(
      [rec({ key: '-100/1', lastSeen: 1000 }), rec({ key: '-100/2', lastSeen: 1900 }),
        rec({ key: '-100/3', lastSeen: 10 })],
      { ...filter, maxAgeMs: 1500 }, // now=2000 → запись 10 старше порога, две другие свежее
    )
    expect(got.map(r => r.key)).toEqual(['-100/2', '-100/1'])
  })

  test('лимит соблюдается', () => {
    const many = Array.from({ length: 9 }, (_, i) => rec({ key: `-100/${i}`, lastSeen: 1000 + i }))
    expect(resumeCandidates(many, { ...filter, limit: 3 })).toHaveLength(3)
  })
})

describe('можно ли поднять кандидата', () => {
  const record: TopicRecord = {
    key: '-100/7', chatId: '-100', dir: '/p/repo', sessionId: 'aaa',
    lastSeen: 1000, status: 'unbound', dirRemoved: false,
  }
  const ok = { dirExists: true, transcriptExists: true }

  test('всё на месте — блока нет', () => {
    expect(candidateBlock(record, ok)).toBeUndefined()
  })

  test('папки нет — своя причина (ворктри придётся резать заново)', () => {
    expect(candidateBlock(record, { ...ok, dirExists: false })).toBe('no-dir')
  })

  test('транскрипт вычищен — своя причина, иначе поднимется ПУСТАЯ сессия', () => {
    expect(candidateBlock(record, { ...ok, transcriptExists: false })).toBe('no-transcript')
  })

  test('разговор держит другой топик — не отдаём', () => {
    expect(candidateBlock(record, { ...ok, ownerKey: '-100/9' })).toBe('owned')
  })

  test('владелец — сам этот топик, это не блок', () => {
    expect(candidateBlock(record, { ...ok, ownerKey: '-100/7' })).toBeUndefined()
  })
})
