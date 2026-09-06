// tmux ops: commands from Telegram → keystrokes into the session's pane. The hub
// lives outside claude, so /restart runs inline (graceful /exit → wait → relaunch).

export type OpsCommand =
  | 'compact' | 'clear' | 'esc' | 'enter' | 'restart' | 'resume' | 'new' | 'fork' | 'status' | 'doctor'
  | 'bind' | 'unbind' | 'allow' | 'model' | 'stop' | 'screen' | 'last' | 'delete' | 'skills' | 'reload'
  | 'stand_up' | 'stand_down' | 'pin' | 'unpin' | 'lang' | 'queue' | 'send'

// `/q` — короткий алиас `/queue`: команда набирается на бегу, посреди чужого хода.
const OPS_ALIASES: Record<string, OpsCommand> = { q: 'queue' }

export function parseOpsCommand(
  text: string,
): { cmd: OpsCommand; bot?: string; arg?: string } | undefined {
  const m =
    /^\/(compact|clear|esc|enter|restart|resume|new|fork|status|doctor|bind|unbind|allow|model|stop|screen|last|delete|skills|reload|stand_up|stand_down|pin|unpin|lang)(?:@(\w+))?(?:\s+(\S.*?))?\s*$/.exec(
      text.trim(),
    ) ??
    // Отдельным разбором, потому что аргумент `/queue` — текст задачи, и он бывает
    // многострочным. Остальные команды принимают короткое слово: разреши им перевод строки —
    // и обычное письмо, начатое с «/new», перестанет быть письмом.
    /^\/(queue|q|send)(?:@(\w+))?(?:\s+(\S[\s\S]*?))?\s*$/.exec(text.trim())
  if (!m) {
    return undefined
  }
  return {
    cmd: OPS_ALIASES[m[1]!] ?? (m[1] as OpsCommand),
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

// Claude Code's live "working" status footer: "<spinner> Gerund… (12s · ↓ 3.4k tokens · thinking)"
// — a word ending in "…" immediately before "(<digit>". Detect it ONLY in the tail: an old
// spinner scrolled up into history must not read as still-busy, and the idle bars
// ("⏵⏵ bypass…", "new task? /clear…", "⎿ Done (…)") lack the "…(<digit>" shape. Used to keep
// "typing…" alive even when two consecutive captures are byte-identical (elapsed hadn't ticked /
// redraw lag), which a pure screen-diff would miss. Pure — tested in core.test.ts.
export function paneIsWorking(text: string): boolean {
  const tail = text.split('\n').filter(l => l.trim() !== '').slice(-8)
  return tail.some(l => /(?:…|\.\.\.)\s*\(\s*\d/.test(l))
}

// Context-window usage % from the pane status line: "<pie> NN%  <bar> MM%  ⏱ …". The first
// percentage (right after the pie glyph ○◔◑◕●) is context occupancy. Scan only the last lines
// (live status area). Pure — tested in core.test.ts.
export function parseContextPct(text: string): number | undefined {
  const lines = text.split('\n').filter(l => l.trim() !== '').slice(-6)
  for (const l of lines) {
    const m = l.match(/[○◔◑◕●]\s*(\d+)\s*%/)
    if (m) {
      return Number(m[1])
    }
  }
  return undefined
}

// Error/auth banners Claude Code prints into the pane that no hook exposes, but the user
// must see (transient API failures, expired login, billing). Anchored at the line start
// after stripping the ⏺/● TUI bullet, on the last visible lines only — so the words don't
// false-trigger as scrollback prose (e.g. a session discussing an API error). Extend the
// list as new banners turn up ("probably something else too" — Roma). Pure — tested in core.test.ts.
const ERROR_SIGNATURES = [
  /^API Error\b/i, // "API Error: Connection closed…", "(Request timed out)", 5xx/429/529 overloaded
  /^Invalid API key/i, // covers "Invalid API key · Please run /login"
  /^OAuth (token|authentication)\b.*(expired|error|invalid)/i,
  /^Login expired/i, // "Login expired · Please run /login" — the banner STARTS here, so the /login pattern below never fires on it
  /^Not logged in\b/i, // "Not logged in · Run /login" — a status line at the bottom of the pane, not a ⏺ banner
  /^Please run \/login/i, // logged out / auth expired (anchored — else it matches prose mentioning /login)
  /^Credit balance is too low/i, // billing
  /^(authentication_error|permission_error|overloaded_error|rate_limit_error)\b/i,
]

export function parseError(text: string): string | undefined {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l !== '').slice(-12)
  for (let i = lines.length - 1; i >= 0; i--) {
    const bare = lines[i].replace(/^[⏺●•*+>│└─⎿╰\s]+/, '')
    if (ERROR_SIGNATURES.some(re => re.test(bare))) {
      return bare.slice(0, 300)
    }
  }
  return undefined
}

// Running-workflow status, scraped from the pane (hooks only expose "workflow-subagent" with
// no name). Claude Code renders one bottom line: "◯ <name>  <description>… NN/MM agents done ·
// …". We pull the real workflow name + agent count from it. Scan only the last lines (live
// status area). Pure — tested in core.test.ts.
export function parseWorkflow(text: string): { name: string; done: number; total: number } | undefined {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l !== '').slice(-8)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*\S\s+(\S+).*?(\d+)\/(\d+)\s+agents done\b/)
    if (m) {
      return { name: m[1], done: Number(m[2]), total: Number(m[3]) }
    }
  }
  return undefined
}

// tmux session name for a binding. MUST match what tmux will actually create: tmux rejects
// '.' and ':' in session names and silently rewrites them to '_' (they are target syntax —
// `session:window.pane`). Without the same rewrite here, a repo dir like `console--GPT-5.6`
// yields a name we can never address again: `send-keys -t =…GPT-5.6---123` parses `.6---123`
// as a pane and dies with "can't find session". Pure — tested in core.test.ts.
export function tmuxSessionName(dirBase: string, key: string, slug?: string): string {
  // Со слагом имя читаемое: `console-site-review`. Без него — прежняя схема от ключа биндинга
  // (id чата и топика): так зовутся сессии, созданные до слагов, и их нельзя переименовать
  // задним числом — хаб найдёт их по имени только под старым.
  const base = slug ? `${dirBase}-${slug}` : `${dirBase}--${key.replace(/[^\w.-]/g, '-')}`
  return base.replace(/[.:\/]/g, '_')
}

/** Пора ли гасить простаивающий биндинг. Чистая — тесты в core.test.ts.
 *
 *  `held` — сессию держат: её запинили или в ней живут кроны/лупы, которые умрут вместе с ней.
 *  `thresholdMs <= 0` выключает выгрузку совсем. */
export function isIdleToUnload(opts: {
  now: number; lastActive: number; thresholdMs: number; held: boolean; working: boolean
}): boolean {
  const { now, lastActive, thresholdMs, held, working } = opts
  return thresholdMs > 0 && !held && !working && now - lastActive >= thresholdMs
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

// `claude -p '<prompt>'` / `--print` is a one-shot headless run: it answers once and exits. Such a
// process still connects as a session (it can carry channel flags + binding keys), so it must be
// distinguishable from a real interactive launch — a binding that "learns" it would relaunch the
// batch prompt on every revive and die immediately, looping. Pure — tested in core.test.ts.
export function isHeadlessArgv(argv: string[]): boolean {
  return argv.some(a => a === '-p' || a === '--print' || a.startsWith('--print='))
}

export function stripResumeFlags(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // --fork-session ставит ТОЛЬКО режим fork. Выученный из живого процесса argv ветки его
    // содержит — оставь, и каждое следующее пробуждение ветки форкало бы её заново, плодя
    // сессии и теряя ту, в которой шёл разговор.
    if (a === '--continue' || a.startsWith('--resume=') || a === '--fork-session') {
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

// Возобновление старой и крупной сессии (>70 мин, >100k токенов) открывает модальный вопрос
// «resume from summary?». В хабе нажать на него в момент подъёма некому, а сообщение, которым
// сессию как раз разбудили, съедается этим промптом — юзеру приходится писать его заново.
// Гасим порогом по возрасту (эквивалент кнопки «Don't ask me again», но только для наших сессий).
export const RESUME_PROMPT_OFF = 'CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999'

// Сессия (или её же bash-команда с жирным выводом) может раздуться на гигабайты и утащить
// в OOM весь хост — вместе с чужими сессиями. TELEGRAM_MEMORY_MAX="6G" запирает сессию с её
// потомками в свой cgroup: упирается в потолок и умирает только виновник. Выключено по
// умолчанию — systemd-run есть только под систему с systemd (на macOS его нет).
//
// TELEGRAM_MEMORY_SLICE кладёт scope'ы сессий в общий slice: одна cgroup отвечает, сколько
// занимают ВСЕ сессии разом (потолок на каждую этого не говорит). Захочешь общий предел —
// он задаётся на том же slice, но по умолчанию его нет: своп разрешён, и ядро справляется само.
//
// Своп сессиям НЕ запрещаем. `MemorySwapMax=0` выглядел защитой от трэшинга, а на деле делал
// их память неизымаемой: ядро оставляло спящую сессию в RAM и выдавливало на диск hermes,
// стенды и сам хаб (замер 2026-08-18: 8 ГБ свопа при живых сессиях в RAM).
// Нет systemd-run — значит нет и systemd (macOS, контейнер): всё, что через него, отключается,
// а не падает. Живая грабля: в docker-стенде `TELEGRAM_MEMORY_MAX` из env превращал КАЖДЫЙ запуск
// агента в «Executable not found in $PATH: systemctl», и топик молча вис без сессии.
const SYSTEMD_RUN = Bun.which('systemd-run')
const SYSTEMCTL = Bun.which('systemctl')

/** `systemctl --user …`; без systemd молча ничего не делает и отдаёт пустой вывод. */
async function systemctlUser(args: string[], capture = false): Promise<string> {
  if (!SYSTEMCTL) {
    return ''
  }
  const proc = Bun.spawn([SYSTEMCTL, '--user', ...args], { stdout: capture ? 'pipe' : 'ignore', stderr: 'ignore' })
  const out = capture ? await new Response(proc.stdout).text() : ''
  await proc.exited
  return out
}

export const memoryCapPrefix = (unit?: string, systemdRun: string | null = SYSTEMD_RUN): string => {
  const cap = process.env.TELEGRAM_MEMORY_MAX?.trim()
  if (!cap || !systemdRun) {
    return ''
  }
  const slice = process.env.TELEGRAM_MEMORY_SLICE?.trim()
  const parts = [
    'systemd-run', '--user', '--scope', '--quiet',
    ...(unit ? [`--unit=${unit}`] : []),
    ...(slice ? [`--slice=${slice}`] : []),
    '-p', `MemoryMax=${cap}`,
    // Убивает сессии не этот потолок, а systemd-oomd — по давлению свопа, задолго до него
    // (25.08: три жертвы при пике 458 МБ против лимита в 6 ГБ). Ставим scope в конец очереди
    // кандидатов: предохранитель на случай настоящего голода остаётся, но первым под нож
    // идёт тот, кто память и съел, а не разговор, который в этот момент шёл.
    '-p', 'ManagedOOMPreference=avoid',
  ]
  return `${shellQuote(parts)} `
}

// Имя scope'а — наша метка владения. Без него cgroup сессии не отличить от чужих transient-scope
// (под ними ходят и ручные задачи хозяина машины), и подчистить брошенное можно только гадая.
// С меткой уборка тривиальна и безопасна: `tgc-*` — наши, всё остальное не трогаем.
export function scopeUnitName(key: string): string {
  return `tgc-${key.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.scope`
}

/** Свободное имя scope'а под этот биндинг: занятое — с суффиксом -2, -3, …
 *
 * Мёртвый scope имя НЕ освобождает: зомби-процесс в его cgroup держит unit загруженным, а
 * `stop` и `reset-failed` на такой husk не действуют (проверено на хосте 27.08). Занятое имя
 * валит `systemd-run --unit=…`, а с ним и подъём топика — 25.08 так намертво встал топик 8100.
 * Подняться под именем -2 лучше, чем не подняться: метка нужна уборщику, а не пользователю.
 */
export async function freeScopeUnitName(
  key: string,
  opts: { limit?: number; isLoaded?: (unit: string) => Promise<boolean> } = {},
): Promise<string> {
  const base = scopeUnitName(key)
  const isLoaded = opts.isLoaded ?? unitIsLoaded
  const limit = opts.limit ?? 20
  for (let n = 1; n <= limit; n++) {
    const name = n === 1 ? base : base.replace(/\.scope$/, `-${n}.scope`)
    if (!(await isLoaded(name))) {
      return name
    }
  }
  return base
}

async function unitIsLoaded(unit: string): Promise<boolean> {
  if (!SYSTEMCTL) {
    return false
  }
  return (await systemctlUser(['show', unit, '-p', 'LoadState', '--value'], true)).trim() === 'loaded'
}

/** Имена НАШИХ scope'ов, внутри которых уже нет живого агента (чистая функция). */
export function deadScopes(scopes: { name: string; commands: string[] }[]): string[] {
  return scopes
    .filter(s => s.name.startsWith('tgc-') && !s.commands.some(cmd => isAgentCommand(cmd)))
    .map(s => s.name)
}

function isAgentCommand(cmd: string): boolean {
  return /(^|\/)(claude|codex)(\s|$)/.test(cmd)
}

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

export function buildLaunch(saved: string[] | undefined, mode: LaunchMode, sessionId?: string): string {
  const base = ensureChannelFlags(stripResumeFlags(saved?.length ? saved : DEFAULT_CLAUDE_ARGV))
  // fork = ветка: та же история до точки разветвления, но своя дальнейшая жизнь. --fork-session
  // без --resume бессмыслен, поэтому без id это обычный старт.
  if (mode === 'fork') {
    return shellQuote(sessionId ? [...base, '--resume', sessionId, '--fork-session'] : base)
  }
  if (mode !== 'resume') {
    return shellQuote(base)
  }
  return shellQuote(sessionId ? [...base, '--resume', sessionId] : [...base, '--continue'])
}

export type LaunchMode = 'resume' | 'new' | 'fork'

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

/** The foreground command is a safety signal, not a process inventory. */
export async function paneCurrentCommand(pane: string): Promise<string> {
  const proc = Bun.spawn(['tmux', 'display-message', '-p', '-t', pane, '#{pane_current_command}'], {
    stdout: 'pipe', stderr: 'ignore',
  })
  await proc.exited
  return (await new Response(proc.stdout).text()).trim()
}

const TYPE_ENTER_GAP_MS = 500
// Seconds the user gets to answer the exit-confirm via Telegram buttons.
export const EXIT_CONFIRM_GRACE_S = 10

// Claude Code 2.1.233 renamed the first choice from "Exit anyway" to
// "Exit and stop tasks".  Both mean that Enter accepts the safe default and
// terminates the background shells; recognize the semantic prompt, not one UI
// revision's wording.
export function isExitConfirm(text: string): boolean {
  return text.includes('Exit anyway') || text.includes('Exit and stop tasks')
}

export async function typeLine(pane: string, text: string): Promise<void> {
  await typeText(pane, text)
  // Claude Code's TUI can eat a rapid-fire Enter as a newline instead of submit
  // (ccgram learned this) — let the text settle before Enter.
  await sleep(TYPE_ENTER_GAP_MS)
  await tmux('send-keys', '-t', pane, 'Enter')
}

/** Type into an already focused inline field without submitting it. */
export async function typeText(pane: string, text: string): Promise<void> {
  await tmux('send-keys', '-t', pane, '-l', text)
}

// Inject a SLASH command literally. Claude Code's "/" autocomplete pops a fuzzy-matched
// suggestion and Enter selects the HIGHLIGHTED one, not the typed text — so typing "/implement"
// could actually run a similar-looking skill (seen live: "/oh" ran "/claude-api"; a real prod
// "/implement" fired "/claude-mem:oh-my-issues"). Escape closes the popup while KEEPING the typed
// text (verified), so the following Enter submits the literal command. Never do this for plain
// text — Escape there interrupts a running turn / clears the line.
export async function typeSlashCommand(pane: string, text: string): Promise<void> {
  await tmux('send-keys', '-t', pane, '-l', text)
  await sleep(TYPE_ENTER_GAP_MS)
  await tmux('send-keys', '-t', pane, 'Escape') // dismiss the "/" autocomplete popup, keep the text
  await sleep(150)
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

// detached tmux defaults to 80×24 — TUI pickers (e.g. /resume) get squeezed onto 1 line;
// set a sane size; on attach the client's size takes over anyway
const DETACHED_SIZE = ['-x', '200', '-y', '100']

// A first `tmux new-session` for a brand-new server is a direct child of this process — left
// alone it inherits OUR systemd cgroup, so a hub restart/crash (KillMode=control-group, the
// default) takes down the tmux server and every session/pane hanging off it, hub-unrelated work
// included. systemd-run --scope gives the server its own cgroup, independent of ours. Without it
// (e.g. macOS) — plain spawn; launchd doesn't cgroup-kill children this way, so the risk this
// guards against doesn't apply there.
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

// like capturePane, but with ANSI codes (-e) — raw material for the /screen PNG render
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

// A line that carries no reading value on its own: blank, or made only of box-drawing / rule
// characters (the input-box borders and separator rules Claude's TUI draws).
const NOISE_LINE_RE = /^[\s─│╭╮╰╯┼┤├┴┬┌┐└┘═║╔╗╚╝▁▏▕▔█░▒▓▌▐▄▀·—–_]*$/u

// /last: the pane as READABLE TEXT — the recent content the user sees (last diff / message) plus
// the live bottom (spinner, token %, permission-mode line), with the giant border runs and blank
// padding stripped. tmux capture is only the visible viewport, so this is "what's on screen now",
// not scrollback. Pure — tested in core.test.ts.
export function paneDigest(text: string, maxLines = 24, maxChars = 3500): string {
  const kept = text
    .split('\n')
    .map(l => l.replace(/\s+$/, '')) // trailing spaces add nothing
    .filter(l => !NOISE_LINE_RE.test(l))
  let out = kept.slice(-maxLines).join('\n').trim()
  if (out.length > maxChars) out = '…\n' + out.slice(out.length - maxChars)
  return out
}

// claude's startup prompts where the default option is preselected (Enter
// confirms): new-folder trust and the dev-channel warning. They can appear in
// sequence (trust first, then dev-warning), so we click both over a ~30s window.

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
async function stopScope(scope: string, log: (s: string) => void): Promise<void> {
  log(`stop: гашу scope ${scope} — вместе со всем, что сессия оставила после себя`)
  await systemctlUser(['stop', scope])
  // Погашенного мало: упавший scope остаётся ЗАГРУЖЕННЫМ, и `systemd-run --unit=<то же имя>`
  // отбивается «already loaded or has a fragment file» — то есть имя занято навсегда, а с ним
  // и подъём этого топика. Освобождает имя только reset-failed. 25.08 так намертво встал
  // топик 8100: запуск печатался снова и снова и падал на одной и той же строке.
  await systemctlUser(['reset-failed', scope])
}

async function scopeCommands(unit: string): Promise<string[]> {
  const path = (await systemctlUser(['show', unit, '-p', 'ControlGroup', '--value'], true)).trim()
  if (!path) {
    return []
  }
  const out: string[] = []
  try {
    const { readFileSync } = require('fs')
    for (const pid of readFileSync(`/sys/fs/cgroup${path}/cgroup.procs`, 'utf8').split('\n')) {
      if (!pid.trim()) {
        continue
      }
      try {
        out.push(readFileSync(`/proc/${pid.trim()}/cmdline`, 'utf8').replace(/\0/g, ' ').trim())
      } catch {} // процесс успел уйти между чтениями — на решение это не влияет
    }
  } catch {} // cgroup исчез — считаем scope пустым, его и погасим
  return out
}

/** Погасить НАШИ scope'ы, где агента уже нет: сессия умерла, а её браузер/сервер держит cgroup. */
export async function reapDeadScopes(log: (s: string) => void): Promise<string[]> {
  // Без --all: гасить нечего в scope'е, который уже inactive. Такой husk (зомби в cgroup) стопом
  // не убирается, и с --all жнец докладывал об одном и том же каждые 5 минут до перезапуска хаба.
  const names = (await systemctlUser(['list-units', '--plain', '--no-legend', '--state=active', 'tgc-*.scope'], true))
    .split('\n').map(l => l.trim().split(/\s+/)[0]).filter(n => n?.endsWith('.scope')) as string[]
  const scopes = await Promise.all(names.map(async name => ({ name, commands: await scopeCommands(name) })))
  const dead = deadScopes(scopes)
  for (const name of dead) {
    log(`scope-reaper: ${name} — агента внутри нет, гашу вместе с остатками`)
    await stopScope(name, log)
  }
  return dead
}

// Сессия живёт в своём transient-scope (см. memoryCapPrefix). У scope нет главного процесса:
// он держится, пока внутри есть ХОТЬ КТО-ТО, — поэтому браузер или dev-сервер, поднятый агентом,
// переживает саму сессию и держит её cgroup (замер 2026-08-18: 460 МБ chrome в scope, где агента
// уже нет). PID 1 в родителях тут ни при чём: владение на Linux задаёт cgroup, а не родитель.
export function transientScopeOf(cgroupText: string): string | undefined {
  const scope = /\/(run-p\d+[^/\s]*\.scope)\s*$/m.exec(cgroupText.trim())?.[1]
  return scope // только наши `systemd-run --scope`; session-*.scope Ромы трогать нельзя
}

function scopeOfPid(pid: number): string | undefined {
  try {
    return transientScopeOf(require('fs').readFileSync(`/proc/${pid}/cgroup`, 'utf8'))
  } catch {
    return undefined
  }
}

export async function stopSession(
  pane: string,
  pid: number,
  log: (s: string) => void,
): Promise<boolean> {
  log(`stop: pane=${pane} pid=${pid}`)
  const scope = scopeOfPid(pid) // читаем ДО убийства: у мёртвого pid cgroup уже не спросишь
  await sendKeys(pane, 'C-c')
  await sleep(1500)
  // Codex exits on Ctrl-C when it is idle.  Do not type Claude's `/exit` into
  // the shell that has already replaced it: apart from a noisy error, that can
  // race the next launch in the same tmux pane.
  if (!alive(pid)) {
    if (scope) {
      await stopScope(scope, log)
    }
    return true
  }
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
    if (isExitConfirm(text)) {
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
  if (alive(pid)) {
    return false
  }
  if (scope) {
    await stopScope(scope, log)
  }
  return true
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
  const cmd = `${RESUME_PROMPT_OFF} ` + envPrefix + memoryCapPrefix() + relaunchCommand(cmdline)
  log(`restart: relaunch ${cmd}`)
  await typeLine(pane, cmd)
  // startup prompts are acked by the hub's screen loop (retries until the prompt is actually gone)
}
