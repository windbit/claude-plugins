import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { messageKey, keyToTarget, targetFor } from '../src/bindings'
import { keysForDir, resolveProjectDir, type BindingEntry } from '../src/registry'
import { makeLineDecoder, encode } from '../src/protocol'
import { Router } from '../src/router'
import { chunk, planAttachments, CAPTION_LIMIT } from '../src/chunk'
import { fmtUntil, formatLimits } from '../src/limits'
import {
  parseOpsCommand, shellQuote, relaunchCommand,
  stripResumeFlags, buildLaunch, DEFAULT_CLAUDE_ARGV,
  parseCompaction,
  parseContextPct,
  parseError,
  parseWorkflow,
  paneIsWorking,
  paneDigest,
  isHeadlessArgv,
  isIdleToUnload,
} from '../src/tmux-ops'
import { isClaudeArgv, claudePidsInDir, cmdlineOf, findClaudeAncestor } from '../src/proc'
import {
  isExcludedTopic, slugFromTopicName, mergeGroupConfig,
  type TrustedGroupConfig, type TrustedGroupMode,
} from '../src/trusted-groups'
import { claudeProjectDir, lastAssistantText } from '../src/session-id'
import { writeFileSync } from 'fs'
import { mdToHtml } from '../src/md-html'

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
    expect(fmtUntil(at(45 * 60), now)).toBe('45m')
    expect(fmtUntil(at(2 * 3600 + 47 * 60), now)).toBe('2h47m')
    expect(fmtUntil(at(3 * 86400 + 4 * 3600), now)).toBe('3d4h')
    expect(fmtUntil(at(-5), now)).toBe('0m')
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
      'Context: 34%',
      'Session 5h: 43%, reset 2h30m',
      'Session 7d: 30%, reset 1d0h',
      '(data 10m ago)',
    ])
    expect(formatLimits({ ageMs: 0 }, now)).toEqual([])
  })
  test('formatLimits: rounds floating-point percentages from upstream', () => {
    const now = 1_000_000_000_000
    const lines = formatLimits({ contextPct: 90, fiveHourPct: 7.000000000000001, ageMs: 0 }, now)
    expect(lines).toEqual(['Context: 90%', 'Session 5h: 7%'])
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
    expect(parseOpsCommand('/clear')).toEqual({ cmd: 'clear' })
    expect(parseOpsCommand('/esc@some_bot ')).toEqual({ cmd: 'esc', bot: 'some_bot' })
    expect(parseOpsCommand('/enter')).toEqual({ cmd: 'enter' })
    expect(parseOpsCommand('/bind myapp')).toEqual({ cmd: 'bind', arg: 'myapp' })
    expect(parseOpsCommand('/bind@bot ~/projects/myapp')).toEqual({
      cmd: 'bind', bot: 'bot', arg: '~/projects/myapp',
    })
    expect(parseOpsCommand('/allow 123 456')).toEqual({ cmd: 'allow', arg: '123 456' })
    expect(parseOpsCommand('/status')).toEqual({ cmd: 'status' })
    expect(parseOpsCommand('/model')).toEqual({ cmd: 'model' })
    expect(parseOpsCommand('/stop')).toEqual({ cmd: 'stop' })
    expect(parseOpsCommand('/screen')).toEqual({ cmd: 'screen' })
    expect(parseOpsCommand('/last')).toEqual({ cmd: 'last' })
    expect(parseOpsCommand('/pin')).toEqual({ cmd: 'pin' })
    expect(parseOpsCommand('/unpin')).toEqual({ cmd: 'unpin' })
    expect(parseOpsCommand('/stand_up')).toEqual({ cmd: 'stand_up' })
    expect(parseOpsCommand('compact')).toBeUndefined()
    expect(parseOpsCommand('/unknown x')).toBeUndefined()
  })

  test('isIdleToUnload: threshold, pinned, working guards', () => {
    const T = 60 * 60_000 // 1h
    const now = 10_000_000
    expect(isIdleToUnload(now, now - T, T, false, false)).toBe(true) // idle exactly the threshold
    expect(isIdleToUnload(now, now - T + 1, T, false, false)).toBe(false) // just under
    expect(isIdleToUnload(now, now - 2 * T, T, true, false)).toBe(false) // pinned → never
    expect(isIdleToUnload(now, now - 2 * T, T, false, true)).toBe(false) // working → wait
    expect(isIdleToUnload(now, now - 2 * T, 0, false, false)).toBe(false) // disabled (0)
  })

  test('isHeadlessArgv: one-shot -p runs must never be learned as a binding launch command', () => {
    // the prod loop: a Role-2 review ran with -p, the hub learned it, and every revive replayed
    // the batch prompt and exited immediately
    expect(isHeadlessArgv(['claude', '-p', 'Role 2 …', '--resume', 'abc'])).toBe(true)
    expect(isHeadlessArgv(['claude', '--print', 'do a thing'])).toBe(true)
    expect(isHeadlessArgv(['claude', '--print=x'])).toBe(true)
    // real interactive launches must still be learned
    expect(isHeadlessArgv(['claude', '--permission-mode', 'bypassPermissions'])).toBe(false)
    expect(isHeadlessArgv(['claude', '--dangerously-load-development-channels', 'server:telegram'])).toBe(false)
    // a flag that merely contains "p" is not headless
    expect(isHeadlessArgv(['claude', '--permission-mode', 'plan'])).toBe(false)
  })

  test('planAttachments: photos album up, caption only when the text really fits one message', () => {
    // one photo + short text → caption, no separate message
    const one = planAttachments(['/a/x.png'], ['hi'])
    expect(one.photos).toEqual([['/a/x.png']])
    expect(one.caption).toBe(true)
    // 3 photos → a single album, caption still allowed (rides on the first item)
    const album = planAttachments(['/a/1.jpg', '/a/2.JPG', '/a/3.webp'], ['caption'])
    expect(album.photos).toEqual([['/a/1.jpg', '/a/2.JPG', '/a/3.webp']])
    expect(album.caption).toBe(true)
    // >10 photos split into albums of 10 — Telegram rejects a bigger group
    const many = planAttachments(Array.from({ length: 23 }, (_, i) => `/a/${i}.png`), ['t'])
    expect(many.photos.map(b => b.length)).toEqual([10, 10, 3])
    // text past the caption cap stays its own message
    expect(planAttachments(['/a/x.png'], ['x'.repeat(CAPTION_LIMIT + 1)]).caption).toBe(false)
    expect(planAttachments(['/a/x.png'], ['x'.repeat(CAPTION_LIMIT)]).caption).toBe(true)
    // split text can't be a caption either — the tail would be lost
    expect(planAttachments(['/a/x.png'], ['part1', 'part2']).caption).toBe(false)
    // no files → nothing to caption
    expect(planAttachments([], ['hi']).caption).toBe(false)
    // non-images stay documents and never join an album
    const mixed = planAttachments(['/a/r.pdf', '/a/p.png'], ['t'])
    expect(mixed.photos).toEqual([['/a/p.png']])
    expect(mixed.docs).toEqual(['/a/r.pdf'])
    // a dotless file is a document, not a photo
    expect(planAttachments(['/a/README'], ['t']).docs).toEqual(['/a/README'])
  })

  test('isClaudeArgv: a bare /cli.js is not claude — that mistook Playwright for a live session', () => {
    // prod: /resume refused with "claude is already running in this folder (pid 12442, 14340)" — those
    // were @playwright/test MCP servers sharing the project cwd, so the binding couldn't revive
    expect(isClaudeArgv([
      'node', '/home/user/projects/agentek-console/node_modules/@playwright/test/cli.js', 'run-test-mcp-server',
    ])).toBe(false)
    expect(isClaudeArgv(['node', '/app/node_modules/vitest/cli.js'])).toBe(false)
    // real claude launch forms must still be recognised
    expect(isClaudeArgv(['claude', '--resume', 'abc'])).toBe(true)
    expect(isClaudeArgv(['/home/user/.local/bin/claude'])).toBe(true)
    expect(isClaudeArgv(['node', '/home/user/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js'])).toBe(true)
    // a project folder merely named "claude-*" must not make someone else's cli.js claude
    expect(isClaudeArgv(['node', '/home/user/projects/claude-tools/node_modules/@playwright/test/cli.js'])).toBe(false)
  })

  test('paneDigest: strips box-drawing/blank noise, keeps recent content + bottom', () => {
    // shape of a real Claude TUI capture: content, blank padding, the input-box border runs,
    // then the live footer (permission-mode + token line).
    const pane = [
      '     #7555  Console stand fully operational',
      '     #7556  migration completed and reported',
      '',
      '⏺ /effort',
      '  ⎿  Cancelled',
      '',
      '',
      '─────────────────────────────────────────────',
      '❯                                             ',
      '─────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · 4%',
    ].join('\n')
    const out = paneDigest(pane)
    expect(out).toContain('migration completed')
    expect(out).toContain('Cancelled')
    expect(out).toContain('bypass permissions on') // the live bottom is kept
    expect(out).not.toMatch(/─{5,}/) // border rules stripped
    expect(out.split('\n').every(l => l.trim() !== '')).toBe(true) // no blank lines
  })

  test('paneDigest: caps to the last maxLines and maxChars', () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    expect(paneDigest(many, 10).split('\n')).toHaveLength(10)
    expect(paneDigest(many, 10)).toContain('line 99')
    expect(paneDigest(many, 10)).not.toContain('line 80')
    const huge = 'x'.repeat(9000)
    expect(paneDigest(huge, 24, 3500).length).toBeLessThanOrEqual(3502) // + the "…\n" prefix
  })

  test('parseCompaction: pane snapshots (real formats)', () => {
    // mid-compaction, with elapsed
    expect(parseCompaction('✻ Compacting conversation… (1m 24s)\n  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 61%'))
      .toEqual({ pct: 61, elapsed: '1m 24s' })
    // early frame, spinner is a dot, no elapsed yet
    expect(parseCompaction('· Compacting conversation…\n  ▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 0%'))
      .toEqual({ pct: 0 })
    // idle pane → nothing
    expect(parseCompaction('❯ yes, do the webhook\n  ◑ 39%  █░░░░░░░░░ 12%  ⏱ 1h50m')).toBeUndefined()
    // the words as scrollback CONTENT, bar not adjacent → must NOT match (the self-scrape bug)
    expect(parseCompaction('discussing Compacting conversation… (elapsed)\nsome other line\nmore text\n  ▰▰▰▰▰▰ 61% example')).toBeUndefined()
  })

  test('parseContextPct: pane status line', () => {
    expect(parseContextPct('❯ \n  ◑ 39%  █░░░░░░░░░ 12%  ⏱ 1h50m')).toBe(39)
    expect(parseContextPct('  ● 93%  ░░░░ 2%  ⏱ 4h24m')).toBe(93)
    expect(parseContextPct('  ○ 0%  ░░░░░░░░░░ 3%')).toBe(0)
    expect(parseContextPct('❯ just some text, no status line')).toBeUndefined()
  })
  test('paneIsWorking: live working footer vs idle/done bars', () => {
    // working spinner footers (must fire typing)
    expect(paneIsWorking('some output\n✢ Spinning… (1m 27s · ↓ 3.7k tokens)')).toBe(true)
    expect(paneIsWorking('* Moonwalking… (17m 41s · ↓ 52.9k tokens · thinking)')).toBe(true)
    expect(paneIsWorking('✢ Spinning... (2s)')).toBe(true) // ascii ellipsis early on
    // idle / done bars (must NOT)
    expect(paneIsWorking('  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents')).toBe(false)
    expect(paneIsWorking('  new task? /clear to save 261.1k tokens')).toBe(false)
    expect(paneIsWorking('⎿  Done (31 tool uses · 80.3k tokens · 4m 8s)')).toBe(false)
    // an old spinner scrolled up into history (>8 lines from bottom) must not read as busy
    expect(paneIsWorking('✢ Spinning… (1m 27s)\n' + Array(10).fill('x').join('\n') + '\n  ⏵⏵ bypass permissions on')).toBe(false)
  })
  test('parseError: banners vs prose', () => {
    // real banner, with the ⏺ bullet, near the bottom
    expect(parseError('⏺ Done — reporting.\n⏺ API Error: Connection closed mid-response. The response above may be incomplete.\n✻ Cogitated'))
      .toBe('API Error: Connection closed mid-response. The response above may be incomplete.')
    expect(parseError('● Invalid API key · Please run /login')).toContain('Invalid API key')
    // the banner starts with "Login expired", not "Please run /login" — the topic stayed silent on every message
    expect(parseError('← telegram · troman29: hi\n● Login expired · Please run /login\n✻ Sautéed for 0s'))
      .toBe('Login expired · Please run /login')
    // the same breakage in another form — a status line at the bottom of the pane, without the glyph
    expect(parseError('                    Not logged in · Run /login\n❯ \n  ○ 7%  ⏱ 4h56m'))
      .toBe('Not logged in · Run /login')
    expect(parseError('  Credit balance is too low')).toBe('Credit balance is too low')
    expect(parseError('⏺ your /login session looks fine, no Please run /login needed')).toBeUndefined() // prose, not line-start
    expect(parseError('❯ just working, no errors here')).toBeUndefined()
  })
  test('parseWorkflow: name + agent count from pane status line', () => {
    expect(parseWorkflow('  ◯ deep-research  Deep research harness — fan-out web… 91/94 agents done · 32m 20s · ↓ 3.7m tokens · ⚠ Large workflow · /workflows to stop'))
      .toEqual({ name: 'deep-research', done: 91, total: 94 })
    expect(parseWorkflow('❯ \n  ● 93%  ░░░░ 2%  ⏱ 4h24m')).toBeUndefined()
    expect(parseWorkflow('just some prose about 5/10 agents done in a sentence')).toBeUndefined() // no leading glyph+name shape
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
  test('buildLaunch: explicit sessionId → --resume <id>, not --continue', () => {
    expect(buildLaunch(['claude'], 'resume', 'abc-123')).toBe(
      'claude --dangerously-load-development-channels server:telegram --resume abc-123',
    )
    expect(buildLaunch(['claude'], 'resume')).toBe(
      'claude --dangerously-load-development-channels server:telegram --continue',
    )
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

describe('trusted-groups', () => {
  const cfg: TrustedGroupConfig = {
    modes: ['folder'],
    dir: '/x',
    exclude: { topicIds: [1, 47], nameContains: ['hermes', '🔒'] },
  }
  test('isExcludedTopic: by id, by substring, neither', () => {
    expect(isExcludedTopic(cfg, 1, 'anything')).toBe(true)
    expect(isExcludedTopic(cfg, 2, 'hermes debug')).toBe(true)
    expect(isExcludedTopic(cfg, 2, 'locked 🔒 topic')).toBe(true)
    expect(isExcludedTopic(cfg, 2, 'fix login bug')).toBe(false)
  })
  test('slugFromTopicName: sanitizes, keeps slashes, falls back', () => {
    expect(slugFromTopicName('feature/foo')).toBe('feature/foo')
    expect(slugFromTopicName('Fix login bug!')).toBe('Fix-login-bug')
    expect(slugFromTopicName('  spaced  ')).toBe('spaced')
    expect(slugFromTopicName('!!!')).toBe('topic')
  })
  test('slugFromTopicName: transliterates Cyrillic (Cyrillic topic names are the norm here, but git branches/tmux names need ASCII)', () => {
    expect(slugFromTopicName('продать BTC')).toBe('prodat-BTC')
    expect(slugFromTopicName('Почини баг с логином')).toBe('Pochini-bag-s-loginom')
  })
  test('mergeGroupConfig: group overrides win, falls back to defaults, dir optional', () => {
    const defaults: { modes: TrustedGroupMode[]; cmdline: string[]; dir: string } = {
      modes: ['folder', 'worktree'], cmdline: ['claude'], dir: '/default',
    }
    expect(mergeGroupConfig(defaults, { dir: '/g' })).toEqual({
      dir: '/g', modes: ['folder', 'worktree'], cmdline: ['claude'], hook: undefined, exclude: undefined,
    })
    expect(mergeGroupConfig(defaults, { modes: ['worktree'], hook: { create: '/h.py' } })).toEqual({
      dir: '/default', modes: ['worktree'], cmdline: ['claude'], hook: { create: '/h.py' }, exclude: undefined,
    })
    expect(mergeGroupConfig(undefined, {})).toEqual({
      dir: undefined, modes: ['folder'], cmdline: undefined, hook: undefined, exclude: undefined,
    })
  })
})

describe('session-id', () => {
  test('claudeProjectDir: sanitizes cwd into the slug Claude Code itself uses', () => {
    expect(claudeProjectDir('/home/user/projects/agentek-console')).toBe(
      join(homedir(), '.claude', 'projects', '-home-user-projects-agentek-console'),
    )
  })

  test('lastAssistantText: final text of the turn, skipping tool-only entries', () => {
    const proj = join('/tmp', `cm-fb-a-${Date.now()}`)
    mkdirSync(claudeProjectDir(proj), { recursive: true })
    const now = Date.now()
    const iso = (ms: number) => new Date(ms).toISOString()
    writeFileSync(
      join(claudeProjectDir(proj), 's.jsonl'),
      [
        JSON.stringify({ type: 'assistant', timestamp: iso(now - 9e4), message: { content: [{ type: 'text', text: 'previous turn' }] } }),
        JSON.stringify({ type: 'user', timestamp: iso(now), message: { content: 'hi' } }),
        JSON.stringify({ type: 'assistant', timestamp: iso(now + 1e3), message: { content: [{ type: 'text', text: 'Done' }] } }),
        JSON.stringify({ type: 'assistant', timestamp: iso(now + 2e3), message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
      ].join('\n') + '\n',
    )
    expect(lastAssistantText(proj, now)).toBe('Done')
  })

  test('lastAssistantText: "" when the turn produced only tool calls (stale text guard)', () => {
    const proj = join('/tmp', `cm-fb-b-${Date.now()}`)
    mkdirSync(claudeProjectDir(proj), { recursive: true })
    const now = Date.now()
    const iso = (ms: number) => new Date(ms).toISOString()
    writeFileSync(
      join(claudeProjectDir(proj), 's.jsonl'),
      [
        JSON.stringify({ type: 'assistant', timestamp: iso(now - 9e4), message: { content: [{ type: 'text', text: 'previous turn reply' }] } }),
        JSON.stringify({ type: 'assistant', timestamp: iso(now + 1e3), message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
      ].join('\n') + '\n',
    )
    expect(lastAssistantText(proj, now)).toBe('')
  })
})

describe('md-html', () => {
  test('mdToHtml: markdown → Telegram HTML', () => {
    expect(mdToHtml('**bold** and *italic*')).toBe('<b>bold</b> and <i>italic</i>')
    expect(mdToHtml('__b__ ~~s~~ `c`')).toBe('<b>b</b> <s>s</s> <code>c</code>')
    expect(mdToHtml('# Heading')).toBe('<b>Heading</b>')
    expect(mdToHtml('- one\n- two')).toBe('• one\n• two')
    expect(mdToHtml('[gh](https://x.com/a?b=1&c=2)')).toBe('<a href="https://x.com/a?b=1&amp;c=2">gh</a>')
  })
  test('mdToHtml: escapes html; code is literal (no md, escaped)', () => {
    expect(mdToHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
    expect(mdToHtml('`<env>-key & **x**`')).toBe('<code>&lt;env&gt;-key &amp; **x**</code>')
    expect(mdToHtml('```\nif (a<b && c) {}\n```')).toBe('<pre>if (a&lt;b &amp;&amp; c) {}</pre>')
  })
  test('mdToHtml: bold inside link, bullet star not italic', () => {
    expect(mdToHtml('[**t**](u)')).toBe('<a href="u"><b>t</b></a>')
    expect(mdToHtml('* item')).toBe('• item')
  })
})
