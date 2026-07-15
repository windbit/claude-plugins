// tmux ops: commands from Telegram → keystrokes into the session's pane. The hub
// lives outside claude, so /restart runs inline (graceful /exit → wait → relaunch).

export type OpsCommand =
  | 'compact' | 'clear' | 'esc' | 'enter' | 'restart' | 'resume' | 'new' | 'status'
  | 'bind' | 'unbind' | 'allow' | 'model' | 'stop' | 'screen'

export function parseOpsCommand(
  text: string,
): { cmd: OpsCommand; bot?: string; arg?: string } | undefined {
  const m = /^\/(compact|clear|esc|enter|restart|resume|new|status|bind|unbind|allow|model|stop|screen)(?:@(\w+))?(?:\s+(\S.*?))?\s*$/.exec(
    text.trim(),
  )
  if (!m) {
    return undefined
  }
  return {
    cmd: m[1] as OpsCommand,
    ...(m[2] ? { bot: m[2] } : {}),
    ...(m[3] ? { arg: m[3] } : {}),
  }
}

// Parse Claude Code's compaction progress out of a pane snapshot. The live UI renders
// "✻ Compacting conversation… (elapsed)" with the "▰▱… NN%" bar on the very next line, in
// the bottom status area. Requiring that adjacency + only scanning the last lines avoids
// false-triggering when those words merely appear as scrollback CONTENT (e.g. a session
// discussing compaction, or showing this feature's own code). Pure — tested in core.test.ts.
export function parseCompaction(text: string): { pct: number; elapsed?: string } | undefined {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l !== '').slice(-10)
  const i = lines.findIndex(l => /Compacting conversation/.test(l))
  if (i === -1) {
    return undefined
  }
  const barLine = [lines[i + 1], lines[i + 2]].find(l => l !== undefined && /[▰▱]{5,}\s*\d+%/.test(l))
  if (!barLine) {
    return undefined // "Compacting conversation" without an adjacent bar = it's content, not the live UI
  }
  const pct = Number(barLine.match(/[▰▱]{5,}\s*(\d+)%/)![1])
  const el = lines[i].match(/\(([^)]+)\)/)
  return { pct, ...(el ? { elapsed: el[1] } : {}) }
}

export function shellQuote(args: string[]): string {
  return args
    .map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ')
}

// Bare --resume is an interactive picker with no one to click it on relaunch →
// convert it to --continue; --resume <id> is deterministic and kept as-is.
export function relaunchCommand(cmdline: string[]): string {
  const args: string[] = []
  let resumable = false
  for (let i = 0; i < cmdline.length; i++) {
    const a = cmdline[i]
    if (a === '--resume') {
      if (i + 1 < cmdline.length && !cmdline[i + 1].startsWith('-')) {
        args.push(a, cmdline[++i])
        resumable = true
      }
      continue
    }
    if (a.startsWith('--resume=')) {
      args.push(a)
      resumable = true
      continue
    }
    if (a === '--continue') {
      resumable = true
    }
    args.push(a)
  }
  const out = ensureChannelFlags(args)
  if (!resumable) {
    out.push('--continue')
  }
  return shellQuote(out)
}

export function stripResumeFlags(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--continue' || a.startsWith('--resume=')) {
      continue
    }
    if (a === '--resume') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        i++
      }
      continue
    }
    out.push(a)
  }
  return out
}

// Default command for /new,/resume when a session's argv hasn't been learned yet.
// Configurable via TELEGRAM_LAUNCH_CMD (e.g. without bypassPermissions — not for
// everyone); channel flags are appended automatically, don't include them.
export const DEFAULT_CLAUDE_ARGV = (
  process.env.TELEGRAM_LAUNCH_CMD ?? 'claude --permission-mode bypassPermissions'
)
  .trim()
  .split(/\s+/)
  .filter(Boolean)

const CHANNEL_FLAGS = new Set(['--channels', '--dangerously-load-development-channels'])

export function stripChannelFlags(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (CHANNEL_FLAGS.has(argv[i])) {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        i++
      }
      continue
    }
    out.push(argv[i])
  }
  return out
}

// Learned argv could carry anything (plugin channel, server: in --channels) —
// channel flags are always rewritten to canon. IMPORTANT: never pass server:* in
// --channels (that's the approved allowlist → the channel is silently dropped);
// the dev flag is its own connection path.
export function ensureChannelFlags(argv: string[]): string[] {
  return [...stripChannelFlags(argv), '--dangerously-load-development-channels', 'server:telegram']
}

export function buildLaunch(saved: string[] | undefined, mode: 'resume' | 'new', sessionId?: string): string {
  const base = ensureChannelFlags(stripResumeFlags(saved?.length ? saved : DEFAULT_CLAUDE_ARGV))
  if (mode !== 'resume') {
    return shellQuote(base)
  }
  return shellQuote(sessionId ? [...base, '--resume', sessionId] : [...base, '--continue'])
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function tmux(...args: string[]): Promise<void> {
  const proc = Bun.spawn(['tmux', ...args], { stdout: 'ignore', stderr: 'pipe' })
  if ((await proc.exited) !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`)
  }
}

export async function sendKeys(pane: string, ...keys: string[]): Promise<void> {
  await tmux('send-keys', '-t', pane, ...keys)
}

const TYPE_ENTER_GAP_MS = 500
// Seconds the user gets to answer the exit-confirm via Telegram buttons.
export const EXIT_CONFIRM_GRACE_S = 10

export async function typeLine(pane: string, text: string): Promise<void> {
  await tmux('send-keys', '-t', pane, '-l', text)
  // Claude Code's TUI can eat a rapid-fire Enter as a newline instead of submit
  // (ccgram learned this) — let the text settle before Enter.
  await sleep(TYPE_ENTER_GAP_MS)
  await tmux('send-keys', '-t', pane, 'Enter')
}

// A picker's numbered options are footer'd "Enter to select · ↑/↓ to navigate" — the
// digit alone only moves the cursor, same as an arrow key; Enter confirms. Sending
// just the digit leaves the picker sitting open (observed 2026-07-15: AskUserQuestion
// re-rendered on every tap — each digit nudged the cursor, producing a new hash the
// hub treated as a fresh picker — until Claude Code gave up and reported "declined").
export async function selectOption(pane: string, index: number): Promise<void> {
  await sendKeys(pane, String(index))
  await sleep(TYPE_ENTER_GAP_MS)
  await sendKeys(pane, 'Enter')
}

export async function hasTmuxSession(name: string): Promise<boolean> {
  const proc = Bun.spawn(['tmux', 'has-session', '-t', `=${name}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return (await proc.exited) === 0
}

// idempotent — used after a worktree delete so a leftover session (bare shell or a
// still-running claude) doesn't linger with its cwd pointed at a now-deleted directory
export async function killTmuxSession(name: string): Promise<void> {
  await tmux('kill-session', '-t', `=${name}`).catch(() => {})
}

export async function ensureTmuxSession(name: string, dir: string): Promise<boolean> {
  if (await hasTmuxSession(name)) {
    return false
  }
  await spawnDetachedTmuxServer(name, dir)
  await sleep(700) // let the shell come up before send-keys
  return true
}

// A first `tmux new-session` for a brand-new server is a direct child of this
// process — left alone it inherits OUR systemd cgroup, so a hub restart/crash
// (KillMode=control-group, the default) takes down the tmux server and every
// session/pane hanging off it, hub-unrelated work included. systemd-run --scope
// gives the server its own cgroup, independent of ours. No systemd-run (e.g.
// macOS) — plain spawn; launchd doesn't cgroup-kill children this way, so the
// risk this guards against doesn't apply there.
const SYSTEMD_RUN = Bun.which('systemd-run')

// detached tmux defaults to 80×24 — TUI-пикеры (напр. /resume) влезают в 1 строку;
// задаём человеческий размер, при attach размер клиента всё равно возьмёт верх
const DETACHED_SIZE = ['-x', '200', '-y', '100']

async function spawnDetachedTmuxServer(name: string, dir: string): Promise<void> {
  if (!SYSTEMD_RUN) {
    await tmux('new-session', '-d', ...DETACHED_SIZE, '-s', name, '-c', dir)
    return
  }
  const unit = `tmux-server-${name.replace(/[^\w.-]/g, '-')}`
  const proc = Bun.spawn(
    [SYSTEMD_RUN, '--user', '--scope', '--collect', `--unit=${unit}`, '--', 'tmux', 'new-session', '-d', ...DETACHED_SIZE, '-s', name, '-c', dir],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  if ((await proc.exited) !== 0) {
    throw new Error(`tmux new-session (detached) failed: ${await new Response(proc.stderr).text()}`)
  }
}

// как capturePane, но с ANSI-кодами (-e) — сырьё для PNG-рендера /screen
export async function capturePaneAnsi(pane: string): Promise<string> {
  const proc = Bun.spawn(['tmux', 'capture-pane', '-e', '-p', '-t', pane], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  await proc.exited
  return await new Response(proc.stdout).text()
}

export async function capturePane(pane: string): Promise<string> {
  const proc = Bun.spawn(['tmux', 'capture-pane', '-p', '-t', pane], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  await proc.exited
  return await new Response(proc.stdout).text()
}

// claude's startup prompts where the default option is preselected (Enter
// confirms): new-folder trust and the dev-channel warning. They can appear in
// sequence (trust first, then dev-warning), so we click both over a ~30s window.
const STARTUP_PROMPTS: Array<{ marker: string; label: string }> = [
  { marker: 'I trust this folder', label: 'folder-trust' },
  { marker: 'I am using this for local development', label: 'dev-channel warning' },
]

export async function ackStartupPrompts(pane: string, log: (s: string) => void): Promise<void> {
  const acked = new Set<string>()
  for (let i = 0; i < 30 && acked.size < STARTUP_PROMPTS.length; i++) {
    await sleep(1000)
    const text = await capturePane(pane).catch(() => '')
    for (const p of STARTUP_PROMPTS) {
      if (!acked.has(p.label) && text.includes(p.marker)) {
        await sendKeys(pane, 'Enter')
        acked.add(p.label)
        log(`${p.label} acknowledged`)
        await sleep(600) // let the next prompt render before re-capturing
      }
    }
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Graceful shutdown: single Ctrl-C first (interrupts a mid-turn agent so /exit
// lands on an idle prompt instead of the message queue), then /exit, answer the
// "Exit anyway?" confirm that appears when background shells are alive, wait
// for the pid to die, escalate to Ctrl-C ×2. Measured: idle exit ~0.6s; busy
// exit hangs forever on the confirm unless answered — hence the pane polling.
export async function stopSession(
  pane: string,
  pid: number,
  log: (s: string) => void,
): Promise<boolean> {
  log(`stop: pane=${pane} pid=${pid}`)
  await sendKeys(pane, 'C-c')
  await sleep(1500)
  await typeLine(pane, '/exit')
  // Graceful window, 1s granularity. The background-shell confirm ("Exit
  // anyway / Move to background / Stay") is surfaced to Telegram as buttons by
  // the hub's picker bridge — give the user EXIT_CONFIRM_GRACE_S to answer it
  // (and see what's running); unanswered → Enter confirms the preselected
  // "1. Exit anyway".
  let confirmSeenAt: number | undefined
  for (let i = 0; i < 30 && alive(pid); i++) {
    await sleep(1000)
    if (!alive(pid)) {
      break
    }
    const text = await capturePane(pane).catch(() => '')
    if (text.includes('Exit anyway')) {
      confirmSeenAt ??= i
      if (i - confirmSeenAt >= EXIT_CONFIRM_GRACE_S) {
        log('stop: confirm unanswered → Enter')
        await sendKeys(pane, 'Enter')
        confirmSeenAt = undefined // reappearing dialog gets a fresh grace window
      }
    }
  }
  if (alive(pid)) {
    log('stop: still alive → Ctrl-C ×2')
    await sendKeys(pane, 'C-c')
    await sleep(1000)
    await sendKeys(pane, 'C-c')
    await sleep(6000)
  }
  return !alive(pid)
}

export async function restartSession(
  pane: string,
  pid: number,
  cmdline: string[],
  bindingKeys: string[],
  log: (s: string) => void,
): Promise<void> {
  await stopSession(pane, pid, log)
  await sleep(3000)
  // TELEGRAM_BINDING_KEYS is a per-command env prefix, not a shell export — the
  // original launch's binding identity dies with the old process unless the relaunch
  // command re-adds it. Without this, the new session's bindingKeys comes back empty:
  // picker routing falls back to "first key bound to this dir" (wrong whenever another
  // key shares the same directory) and the subagent/task/skill status hooks go silent
  // entirely (subagent-hook.ts no-ops with no bindingKeys).
  const envPrefix = bindingKeys.length ? `TELEGRAM_BINDING_KEYS=${shellQuote([bindingKeys.join(',')])} ` : ''
  const cmd = envPrefix + relaunchCommand(cmdline)
  log(`restart: relaunch ${cmd}`)
  await typeLine(pane, cmd)
  await ackStartupPrompts(pane, log)
}
