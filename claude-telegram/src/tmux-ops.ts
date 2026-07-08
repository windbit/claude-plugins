// tmux ops: commands from Telegram → keystrokes into the session's pane. The hub
// lives outside claude, so /restart runs inline (graceful /exit → wait → relaunch).

export type OpsCommand =
  | 'compact' | 'esc' | 'restart' | 'resume' | 'new' | 'status'
  | 'bind' | 'unbind' | 'allow'

export function parseOpsCommand(
  text: string,
): { cmd: OpsCommand; bot?: string; arg?: string } | null {
  const m = /^\/(compact|esc|restart|resume|new|status|bind|unbind|allow)(?:@(\w+))?(?:\s+(\S.*?))?\s*$/.exec(
    text.trim(),
  )
  if (!m) return null
  return {
    cmd: m[1] as OpsCommand,
    ...(m[2] ? { bot: m[2] } : {}),
    ...(m[3] ? { arg: m[3] } : {}),
  }
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
  if (!resumable) out.push('--continue')
  return shellQuote(out)
}

export function stripResumeFlags(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--continue' || a.startsWith('--resume=')) continue
    if (a === '--resume') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) i++
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
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) i++
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

export function buildLaunch(saved: string[] | undefined, mode: 'resume' | 'new'): string {
  const base = ensureChannelFlags(stripResumeFlags(saved?.length ? saved : DEFAULT_CLAUDE_ARGV))
  return shellQuote(mode === 'resume' ? [...base, '--continue'] : base)
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

export async function typeLine(pane: string, text: string): Promise<void> {
  await tmux('send-keys', '-t', pane, '-l', text)
  await tmux('send-keys', '-t', pane, 'Enter')
}

export async function hasTmuxSession(name: string): Promise<boolean> {
  const proc = Bun.spawn(['tmux', 'has-session', '-t', `=${name}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return (await proc.exited) === 0
}

export async function ensureTmuxSession(name: string, dir: string): Promise<boolean> {
  if (await hasTmuxSession(name)) return false
  await tmux('new-session', '-d', '-s', name, '-c', dir)
  await sleep(700) // let the shell come up before send-keys
  return true
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

export async function restartSession(
  pane: string,
  pid: number,
  cmdline: string[],
  log: (s: string) => void,
): Promise<void> {
  log(`restart: pane=${pane} pid=${pid}`)
  await typeLine(pane, '/exit')
  for (let i = 0; i < 35 && alive(pid); i++) await sleep(2000)
  if (alive(pid)) {
    log('restart: still alive → Ctrl-C ×2')
    await sendKeys(pane, 'C-c')
    await sleep(1000)
    await sendKeys(pane, 'C-c')
    await sleep(6000)
  }
  await sleep(3000)
  const cmd = relaunchCommand(cmdline)
  log(`restart: relaunch ${cmd}`)
  await typeLine(pane, cmd)
  await ackStartupPrompts(pane, log)
}
