// Resolve a working directory for an auto-topic binding, per trusted-group mode.
import { basename, dirname, join } from 'path'
import type { HookConfig, TrustedGroupMode } from './trusted-groups'

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: 'ignore' | 'inherit' } = {},
) {
  const proc = Bun.spawn(cmd, { ...opts, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { ok: (await proc.exited) === 0, out, err }
}

export async function gitBranch(dir: string): Promise<string | undefined> {
  const res = await run(['git', '-C', dir, 'branch', '--show-current'])
  const branch = res.ok ? res.out.trim() : ''
  return branch || undefined
}

export async function resolveWorktreeDir(baseDir: string, branch: string): Promise<string> {
  const slug = branch.replace(/\//g, '+')
  const dir = join(dirname(baseDir), `${basename(baseDir)}--${slug}`)
  const exists = await run(['git', '-C', baseDir, 'rev-parse', '--verify', '--quiet', branch])
  const res = exists.ok
    ? await run(['git', '-C', baseDir, 'worktree', 'add', dir, branch])
    : await run(['git', '-C', baseDir, 'worktree', 'add', '-b', branch, dir])
  if (!res.ok) {
    throw new Error(`git worktree add failed: ${(res.err || res.out).trim()}`)
  }
  return dir
}

function fillTemplate(template: string, branch: string, dir: string): string {
  return template.replaceAll('{branch}', branch).replaceAll('{dir}', dir)
}

async function runHookCommand(template: string, branch: string, groupDir: string) {
  const cmd = fillTemplate(template, branch, groupDir)
  return run(['sh', '-c', cmd], {
    cwd: groupDir,
    stdin: 'ignore', // forces non-interactive defaults (isatty()===false) — no hang on a prompt
    env: { ...process.env, TELEGRAM_TOPIC_BRANCH: branch, TELEGRAM_GROUP_DIR: groupDir },
  })
}

export async function resolveHookDir(hook: HookConfig, branch: string, groupDir: string): Promise<string> {
  const res = await runHookCommand(hook.create, branch, groupDir)
  if (!res.ok) {
    throw new Error(`hook create failed: ${(res.err || res.out).trim()}`)
  }
  const lines = res.out.trim().split('\n').filter(Boolean)
  const dir = lines[lines.length - 1]?.trim()
  if (!dir) {
    throw new Error('hook create printed no path')
  }
  return dir
}

export async function runHookDelete(hook: HookConfig, branch: string, groupDir: string): Promise<void> {
  if (!hook.delete) {
    return
  }
  const res = await runHookCommand(hook.delete, branch, groupDir)
  if (!res.ok) {
    throw new Error(`hook delete failed: ${(res.err || res.out).trim()}`)
  }
}

export async function resolveModeDir(
  mode: TrustedGroupMode,
  baseDir: string,
  hook: HookConfig | undefined,
  branch: string,
): Promise<string> {
  if (mode === 'folder') {
    return baseDir
  }
  if (mode === 'worktree') {
    return resolveWorktreeDir(baseDir, branch)
  }
  if (!hook) {
    throw new Error('mode: hook requires "hook" in trusted-groups.json')
  }
  return resolveHookDir(hook, branch, baseDir)
}
