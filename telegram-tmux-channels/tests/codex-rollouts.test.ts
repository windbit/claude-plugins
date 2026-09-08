// Список сессий Codex: у него нет каталога по проекту, поэтому «сессии этой папки» — обход
// ВСЕХ роллаутов. Замер на живой машине: 2664 файла, скан стоил 3.6 с и звался из пяти горячих
// путей; а роллауты сабагентов лежат теми же файлами с той же папкой — у habebe-trader их
// оказалось 11 против 10 настоящих сессий, и пикер показывал бы почти одних их.
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { codexRollouts, parseRolloutMeta, recentCodexSessions } from '../src/agents/codex'

const meta = (payload: Record<string, unknown>) => JSON.stringify({ type: 'session_meta', payload })
const userTurn = (text: string) => JSON.stringify({
  type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
})

describe('parseRolloutMeta', () => {
  test('настоящая сессия: source — строка', () => {
    expect(parseRolloutMeta(meta({ id: 'a', cwd: '/work', source: 'cli' }))).toEqual({ id: 'a', cwd: '/work' })
  })

  test('сабагент отсеивается по объектному source', () => {
    const subagent = meta({ id: 'b', cwd: '/work', source: { subagent: { thread_spawn: { depth: 1 } } } })
    expect(parseRolloutMeta(subagent)).toBeUndefined()
  })

  test('без папки метаданные бесполезны', () => {
    expect(parseRolloutMeta(meta({ id: 'c', source: 'exec' }))).toBeUndefined()
  })

  test('не session_meta и мусор не роняют разбор', () => {
    expect(parseRolloutMeta(userTurn('привет'))).toBeUndefined()
    expect(parseRolloutMeta('{"type":"session_meta её обрезало')).toBeUndefined()
  })
})

describe('codexRollouts на диске', () => {
  const roots: string[] = []
  const home = () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
    roots.push(root)
    process.env.CODEX_HOME = root
    process.env.TELEGRAM_STATE_DIR = mkdtempSync(join(tmpdir(), 'codex-state-'))
    roots.push(process.env.TELEGRAM_STATE_DIR)
    const day = join(root, 'sessions', '2026', '09', '08')
    mkdirSync(day, { recursive: true })
    return day
  }
  const write = (day: string, name: string, lines: string[]) =>
    writeFileSync(join(day, name), lines.join('\n') + '\n')

  afterEach(() => {
    delete process.env.CODEX_HOME
    delete process.env.TELEGRAM_STATE_DIR
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  test('сабагент той же папки в список не попадает', () => {
    const day = home()
    write(day, 'rollout-real.jsonl', [meta({ id: 'real', cwd: '/work/app', source: 'cli' }), userTurn('почини сборку')])
    write(day, 'rollout-sub.jsonl', [
      meta({ id: 'sub', cwd: '/work/app', source: { subagent: { thread_spawn: { parent_thread_id: 'real' } } } }),
      userTurn('ты ревьюер, проверь патч'),
    ])
    expect(codexRollouts('/work/app').map(r => r.id)).toEqual(['real'])
    expect(recentCodexSessions('/work/app')[0]).toMatchObject({ id: 'real', snippet: 'почини сборку' })
  })

  test('чужая папка не смешивается со своей', () => {
    const day = home()
    write(day, 'rollout-mine.jsonl', [meta({ id: 'mine', cwd: '/work/app', source: 'exec' }), userTurn('мой запрос')])
    write(day, 'rollout-alien.jsonl', [meta({ id: 'alien', cwd: '/work/other', source: 'exec' }), userTurn('чужой')])
    expect(codexRollouts('/work/app').map(r => r.id)).toEqual(['mine'])
  })

  test('новый роллаут виден сразу, удалённый исчезает — кэш не залипает', () => {
    const day = home()
    write(day, 'rollout-a.jsonl', [meta({ id: 'a', cwd: '/work/app', source: 'cli' }), userTurn('первый')])
    expect(codexRollouts('/work/app').map(r => r.id)).toEqual(['a'])
    write(day, 'rollout-b.jsonl', [meta({ id: 'b', cwd: '/work/app', source: 'cli' }), userTurn('второй')])
    expect(codexRollouts('/work/app').map(r => r.id).sort()).toEqual(['a', 'b'])
    rmSync(join(day, 'rollout-a.jsonl'))
    expect(codexRollouts('/work/app').map(r => r.id)).toEqual(['b'])
  })

  test('бутстрап-конверт не идёт на подпись', () => {
    const day = home()
    write(day, 'rollout-env.jsonl', [
      meta({ id: 'env', cwd: '/work/app', source: 'cli' }),
      userTurn('<environment_context>cwd /work/app shell bash</environment_context>'),
      userTurn('[Telegram message; delivery_id="d1"]\nсобери релиз'),
    ])
    expect(recentCodexSessions('/work/app')[0]?.snippet).toBe('собери релиз')
  })
})
