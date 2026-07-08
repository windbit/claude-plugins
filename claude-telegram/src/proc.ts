// Cross-platform process introspection: Linux — /proc, macOS — ps/lsof.
// All functions are synchronous (the stub calls them at startup, before the event loop).
import { readFileSync, readlinkSync, readdirSync } from 'fs'

const isLinux = process.platform === 'linux'

function ps(args: string[]): string {
  try {
    return Bun.spawnSync(['ps', ...args]).stdout.toString()
  } catch {
    return ''
  }
}

/** Process argv (not word-split when the OS hands back a single string). */
export function cmdlineOf(pid: number): string[] {
  if (isLinux) {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
  }
  // macOS: ps returns the whole command line; split on spaces — good enough to
  // recognise claude and its flags (paths with spaces are rare here).
  const out = ps(['-o', 'command=', '-p', String(pid)]).trim()
  return out ? out.split(/\s+/) : []
}

/** Process ppid; 0/NaN if not found. */
export function parentPid(pid: number): number {
  if (isLinux) {
    // field 4 after the last ')' — comm may contain spaces/parens
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  }
  return Number(ps(['-o', 'ppid=', '-p', String(pid)]).trim())
}

/** Process cwd, or undefined. */
export function cwdOf(pid: number): string | undefined {
  try {
    if (isLinux) return readlinkSync(`/proc/${pid}/cwd`)
    // macOS: lsof -a -d cwd — "n<path>" line in -F format
    const out = Bun.spawnSync(['lsof', '-a', '-d', 'cwd', '-p', String(pid), '-Fn']).stdout.toString()
    const line = out.split('\n').find(l => l.startsWith('n'))
    return line ? line.slice(1) : undefined
  } catch {
    return undefined
  }
}

/** All pids whose command is claude (system-wide). */
export function claudePids(): number[] {
  if (isLinux) {
    let entries: string[]
    try {
      entries = readdirSync('/proc')
    } catch {
      return []
    }
    const out: number[] = []
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue
      try {
        if (isClaudeArgv(cmdlineOf(Number(name)))) out.push(Number(name))
      } catch {}
    }
    return out
  }
  // macOS: pgrep by binary name
  const out = Bun.spawnSync(['pgrep', '-x', 'claude']).stdout.toString().trim()
  return out ? out.split('\n').map(Number).filter(Boolean) : []
}

export function isClaudeArgv(argv: string[]): boolean {
  return argv.some(
    a => a === 'claude' || a.endsWith('/claude') || a.endsWith('/cli.js') || a.endsWith('\\claude.exe'),
  )
}

/** claude pids whose cwd == dir. Catches foreign sessions without channels too. */
export function claudePidsInDir(dir: string): number[] {
  return claudePids().filter(pid => cwdOf(pid) === dir)
}

/** Walk up the process tree from the stub to the claude process. */
export function findClaudeAncestor(startPid: number): { pid: number; cmdline: string[] } | null {
  let pid = startPid
  for (let hops = 0; hops < 10 && pid > 1; hops++) {
    let cmdline: string[]
    try {
      cmdline = cmdlineOf(pid)
    } catch {
      return null
    }
    if (isClaudeArgv(cmdline)) return { pid, cmdline }
    const parent = parentPid(pid)
    if (!parent || parent === pid) return null
    pid = parent
  }
  return null
}
