import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { messageKey, keyToTarget, targetFor } from '../src/bindings'
import { keysForDir, resolveProjectDir, type BindingEntry } from '../src/registry'
import { makeLineDecoder, encode } from '../src/protocol'
import { Router } from '../src/router'
import { chunk } from '../src/chunk'
import { fmtUntil, formatLimits } from '../src/limits'
import {
  parseOpsCommand, shellQuote, relaunchCommand,
  stripResumeFlags, buildLaunch, DEFAULT_CLAUDE_ARGV,
} from '../src/tmux-ops'
import { isClaudeArgv, claudePidsInDir, cmdlineOf, findClaudeAncestor } from '../src/proc'

describe('bindings', () => {
  test('messageKey: dm / topic / group', () => {
    expect(messageKey({ chatType: 'private', chatId: '5' })).toBe('dm:5')
    expect(messageKey({ chatType: 'supergroup', chatId: '-1', threadId: 2 })).toBe('-1/2')
    expect(messageKey({ chatType: 'supergroup', chatId: '-1' })).toBe('-1')
  })
  test('keyToTarget expands a key back', () => {
    expect(keyToTarget('dm:5')).toEqual({ chat_id: '5' })
    expect(keyToTarget('-1/2')).toEqual({ chat_id: '-1', thread_id: 2 })
    expect(keyToTarget('-1')).toEqual({ chat_id: '-1' })
    expect(() => keyToTarget('garbage')).toThrow('bad binding key')
  })
  test('targetFor: single key auto-fills; several need chat_id', () => {
    expect(targetFor(['-1/2'])).toEqual({ chat_id: '-1', thread_id: 2 })
    expect(targetFor(['dm:9'])).toEqual({ chat_id: '9' })
    expect(() => targetFor(['-1/2', 'dm:9'])).toThrow('several chats')
    expect(targetFor(['-1/2', 'dm:9'], '-1')).toEqual({ chat_id: '-1', thread_id: 2 })
    expect(targetFor(['-1/2', 'dm:9'], '9')).toEqual({ chat_id: '9' })
    expect(targetFor(['-1/2'], '-1', '5')).toEqual({ chat_id: '-1', thread_id: 5 })
    expect(() => targetFor(['-1/2', '-1/3'], '-1')).toThrow('pass thread_id')
    expect(() => targetFor([])).toThrow('not bound')
  })
})

describe('registry', () => {
  test('keysForDir: all keys for a dir', () => {
    const reg: Record<string, BindingEntry> = {
      '-1/2': { dir: '/a' },
      'dm:9': { dir: '/a' },
      '-1/3': { dir: '/b' },
    }
    expect(keysForDir(reg, '/a').sort()).toEqual(['-1/2', 'dm:9'])
    expect(keysForDir(reg, '/c')).toEqual([])
  })
  test('resolveProjectDir: name → projectsRoot, absolute path, non-dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-'))
    mkdirSync(join(root, 'myapp'))
    expect(resolveProjectDir('myapp', root)).toBe(join(root, 'myapp'))
    expect(resolveProjectDir(join(root, 'myapp'), root)).toBe(join(root, 'myapp'))
    expect(() => resolveProjectDir('no-such', root)).toThrow('not a directory')
  })
})

describe('protocol', () => {
  test('decoder assembles messages from torn chunks', () => {
    const got: unknown[] = []
    const feed = makeLineDecoder<unknown>(m => got.push(m), () => {})
    const wire = encode({ op: 'a' }) + encode({ op: 'b' })
    feed(wire.slice(0, 5))
    feed(wire.slice(5))
    expect(got).toEqual([{ op: 'a' }, { op: 'b' }])
  })
  test('bad line → onErr, stream survives', () => {
    const got: unknown[] = []
    let errs = 0
    const feed = makeLineDecoder<unknown>(m => got.push(m), () => errs++)
    feed('not json\n' + encode({ ok: 1 }))
    expect(errs).toBe(1)
    expect(got).toEqual([{ ok: 1 }])
  })
})

describe('router', () => {
  test('byDir: sessions by dir; unsubscribe removes', () => {
    const r = new Router<string>()
    r.subscribe('A', { cwd: '/a' })
    r.subscribe('B', { cwd: '/b' })
    r.subscribe('C', { cwd: '/a' })
    expect(r.byDir('/a').sort()).toEqual(['A', 'C'])
    expect(r.byDir('/c')).toEqual([])
    r.unsubscribe('A')
    expect(r.byDir('/a')).toEqual(['C'])
  })
  test('byBindingKey: disambiguates sessions sharing a dir', () => {
    const r = new Router<string>()
    r.subscribe('A', { cwd: '/shared', bindingKeys: ['-1/2'] })
    r.subscribe('B', { cwd: '/shared', bindingKeys: ['-1/3'] })
    expect(r.byDir('/shared').sort()).toEqual(['A', 'B'])
    expect(r.byBindingKey('-1/2')).toEqual(['A'])
    expect(r.byBindingKey('-1/3')).toEqual(['B'])
    expect(r.byBindingKey('-1/4')).toEqual([])
  })
})

describe('limits', () => {
  test('fmtUntil: m / h / d', () => {
    const now = 1_000_000_000_000
    const at = (secs: number) => Math.floor(now / 1000) + secs
    expect(fmtUntil(at(45 * 60), now)).toBe('45м')
    expect(fmtUntil(at(2 * 3600 + 47 * 60), now)).toBe('2ч47м')
    expect(fmtUntil(at(3 * 86400 + 4 * 3600), now)).toBe('3д4ч')
    expect(fmtUntil(at(-5), now)).toBe('0м')
  })
  test('formatLimits: line + stale marker', () => {
    const now = 1_000_000_000_000
    const l = {
      contextPct: 34,
      fiveHourPct: 43,
      fiveHourResetsAt: Math.floor(now / 1000) + 9000,
      sevenDayPct: 30,
      sevenDayResetsAt: Math.floor(now / 1000) + 86400,
      ageMs: 10 * 60 * 1000,
    }
    const lines = formatLimits(l, now)
    expect(lines).toEqual([
      'контекст 34%',
      '5ч 43%, сброс 2ч30м',
      '7д 30%, сброс 1д0ч',
      '(данные 10м назад)',
    ])
    expect(formatLimits({ ageMs: 0 }, now)).toEqual([])
  })
})

describe('chunk', () => {
  test('short stays whole; long splits without loss', () => {
    expect(chunk('hi', 10, 'length')).toEqual(['hi'])
    const text = 'a'.repeat(25)
    const parts = chunk(text, 10, 'length')
    expect(parts.join('')).toBe(text)
    expect(Math.max(...parts.map(p => p.length))).toBeLessThanOrEqual(10)
  })
  test('newline mode prefers a paragraph boundary (past half the limit)', () => {
    const text = 'x'.repeat(20) + '\n\n' + 'y'.repeat(20)
    expect(chunk(text, 30, 'newline')).toEqual(['x'.repeat(20), 'y'.repeat(20)])
  })
})

describe('tmux-ops', () => {
  test('parseOpsCommand: commands, @botname, args, garbage', () => {
    expect(parseOpsCommand('/compact')).toEqual({ cmd: 'compact' })
    expect(parseOpsCommand('/esc@some_bot ')).toEqual({ cmd: 'esc', bot: 'some_bot' })
    expect(parseOpsCommand('/bind myapp')).toEqual({ cmd: 'bind', arg: 'myapp' })
    expect(parseOpsCommand('/bind@bot ~/projects/myapp')).toEqual({
      cmd: 'bind', bot: 'bot', arg: '~/projects/myapp',
    })
    expect(parseOpsCommand('/allow 123 456')).toEqual({ cmd: 'allow', arg: '123 456' })
    expect(parseOpsCommand('/status')).toEqual({ cmd: 'status' })
    expect(parseOpsCommand('compact')).toBeUndefined()
    expect(parseOpsCommand('/unknown x')).toBeUndefined()
  })
  test('shellQuote: quotes only where needed', () => {
    expect(shellQuote(["it's"])).toBe(`'it'\\''s'`)
    expect(shellQuote(['claude', '--continue', '/a b/c'])).toBe(`claude --continue '/a b/c'`)
  })
  test('stripResumeFlags: --continue, --resume [id], --resume=id', () => {
    expect(stripResumeFlags(['claude', '--continue', '-p'])).toEqual(['claude', '-p'])
    expect(stripResumeFlags(['claude', '--resume', 'abc-123', '-p'])).toEqual(['claude', '-p'])
    expect(stripResumeFlags(['claude', '--resume', '--verbose'])).toEqual(['claude', '--verbose'])
    expect(stripResumeFlags(['claude', '--resume=abc'])).toEqual(['claude'])
  })
  test('buildLaunch: learned argv or default; channel flags always added', () => {
    expect(buildLaunch(['claude', '--resume', 'x'], 'resume')).toBe(
      'claude --dangerously-load-development-channels server:telegram --continue',
    )
    expect(buildLaunch(['claude', '--continue'], 'new')).toBe(
      'claude --dangerously-load-development-channels server:telegram',
    )
    // default argv (from env/default) has NO channel flags; buildLaunch adds them
    const withChannel = DEFAULT_CLAUDE_ARGV.join(' ') + ' --dangerously-load-development-channels server:telegram'
    expect(buildLaunch(undefined, 'new')).toBe(withChannel)
    expect(buildLaunch([...DEFAULT_CLAUDE_ARGV], 'new')).toBe(withChannel)
  })
  test('relaunchCommand: bare --resume → --continue; --resume <id> kept', () => {
    expect(relaunchCommand(['claude', '--resume'])).toBe(
      'claude --dangerously-load-development-channels server:telegram --continue',
    )
    expect(relaunchCommand(['claude', '--resume', 'abc-123'])).toBe(
      'claude --resume abc-123 --dangerously-load-development-channels server:telegram',
    )
    expect(relaunchCommand(['claude', '--permission-mode', 'bypassPermissions'])).toBe(
      'claude --permission-mode bypassPermissions --dangerously-load-development-channels server:telegram --continue',
    )
  })
  test('ensureChannelFlags rewrites any old channel flags to canon', () => {
    // learned argv with an old plugin channel → the plugin ref is dropped
    expect(
      buildLaunch(['claude', '--channels', 'plugin:telegram@claude-plugins-official', '--resume'], 'resume'),
    ).toBe(
      'claude --dangerously-load-development-channels server:telegram --continue',
    )
    // a flag without its argument (broken argv) is normalised too
    expect(
      buildLaunch(['claude', '--channels', 'server:telegram', '--dangerously-load-development-channels'], 'new'),
    ).toBe('claude --dangerously-load-development-channels server:telegram')
  })
  test('isClaudeArgv recognises the binary and cli.js', () => {
    expect(isClaudeArgv(['node', '/usr/lib/claude/cli.js', '--resume'])).toBe(true)
    expect(isClaudeArgv(['/home/u/.local/bin/claude'])).toBe(true)
    expect(isClaudeArgv(['bun', 'run', 'stub.ts'])).toBe(false)
  })
  test('claudePidsInDir: array, empty for a nonexistent dir', () => {
    expect(claudePidsInDir('/nonexistent-dir-xyz-42')).toEqual([])
  })
  test('proc introspection works on this host (self)', () => {
    // the current process reads via cmdlineOf without throwing
    const argv = cmdlineOf(process.pid)
    expect(Array.isArray(argv)).toBe(true)
    expect(argv.length).toBeGreaterThan(0)
    // tree walk: either null or a valid claude ancestor (never throws)
    const anc = findClaudeAncestor(process.pid)
    if (anc) expect(isClaudeArgv(anc.cmdline)).toBe(true)
  })
})
