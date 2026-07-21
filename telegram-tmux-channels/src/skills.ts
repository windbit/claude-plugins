// Skill discovery for Telegram slash-command registration.
//
// Two shapes of skill reach Telegram differently (user's split):
//   • GLOBAL skills (user ~/.claude/skills + enabled plugins) → registered as bot
//     commands so every chat gets native /-autocomplete.
//   • PROJECT-local skills (<dir>/.claude/skills) → an interactive button menu
//     (Telegram command scopes are per-chat, not per-topic, so a forum can't get
//     per-project native autocomplete anyway).
//
// The authoritative "what does Claude Code actually expose" list is NOT a filesystem
// walk (that over-counts nested/reference SKILL.md — mattpocock shows 41 files but 22
// real skills). `claude plugin details <name>` is Claude Code's own resolver, so we
// take the NAME set from there and pull descriptions from SKILL.md frontmatter.
//
// Telegram bot-command constraints: name ∈ [a-z0-9_]{1,32}, description 1-256 chars,
// ≤100 commands total. A skill's real slash name keeps hyphens (/deep-research); the
// registered command is mangled (deep_research) and reverse-mapped on invocation.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const pexec = promisify(execFile)

// The hub runs as a systemd user service whose PATH lacks ~/.local/bin, so `claude`
// must be resolved to an absolute path or `plugin details` fails ENOENT (→ 0 skills).
function claudeBin(): string {
  for (const c of [join(homedir(), '.local/bin/claude'), '/usr/local/bin/claude']) {
    if (existsSync(c)) {
      return c
    }
  }
  return 'claude'
}

export type Skill = { name: string; description: string }

// "  Skills (14)  brainstorming, tdd, writing-plans" → ['brainstorming','tdd',…]
export function parseSkillsLine(detailsOutput: string): string[] {
  // [ \t] not \s for the separator: \s matches newlines, so a content-less "Skills (0)"
  // line would let (.+) jump to the next line ("Agents (1) …") and capture it as a skill.
  const m = detailsOutput.match(/^[ \t]*Skills \(\d+\)[ \t]+(\S.*)$/m)
  if (!m) {
    return []
  }
  return m[1]!.split(',').map(s => s.trim()).filter(Boolean)
}

// Telegram command name from a skill name (hyphens/colons/dots → underscore).
export function mangleCmd(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
}

// Pull a scalar or block-scalar field out of the leading --- frontmatter block only.
export function frontmatterField(src: string, field: 'name' | 'description'): string | undefined {
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) {
    return undefined
  }
  const lines = fm[1]!.split('\n')
  const idx = lines.findIndex(l => new RegExp(`^${field}:`).test(l))
  if (idx === -1) {
    return undefined
  }
  let v = lines[idx]!.slice(field.length + 1).trim()
  if (v === '' || v === '|' || v === '>' || v === '|-' || v === '>-') {
    // block scalar — take the following indented lines until dedent/blank
    const out: string[] = []
    for (let i = idx + 1; i < lines.length; i++) {
      const l = lines[i]!
      if (l.trim() === '' || /^\s/.test(l)) {
        out.push(l.trim())
      } else {
        break
      }
    }
    v = out.join(' ').trim()
  } else {
    v = v.replace(/^["']|["']$/g, '')
  }
  return v || undefined
}

// Telegram rejects newlines and >256-char descriptions.
export function tgDescription(desc: string): string {
  const one = desc.replace(/\s+/g, ' ').trim()
  return (one.length > 256 ? one.slice(0, 255) + '…' : one) || '—'
}

function walkSkillMd(root: string, depth: number, acc: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') {
      continue
    }
    const p = join(root, e.name)
    if (e.isDirectory() && depth > 0) {
      walkSkillMd(p, depth - 1, acc)
    } else if (e.isFile() && e.name === 'SKILL.md') {
      acc.push(p)
    }
  }
  return acc
}

// name → description index, built by walking SKILL.md under the given roots.
function descIndex(roots: string[]): Map<string, string> {
  const idx = new Map<string, string>()
  for (const root of roots) {
    for (const f of walkSkillMd(root, 5)) {
      let src: string
      try {
        src = readFileSync(f, 'utf8').slice(0, 8000)
      } catch {
        continue
      }
      const name = frontmatterField(src, 'name')
      if (name && !idx.has(name)) {
        idx.set(name, frontmatterField(src, 'description') ?? name)
      }
    }
  }
  return idx
}

// Enabled plugins: installPaths from installed_plugins.json, filtered by the
// enabledPlugins map in ~/.claude/settings.json ("plugin@market": true/false).
// `claude plugin disable` flips the flag to false, so an installed-but-disabled
// plugin (e.g. superpowers) drops out here.
function enabledPlugins(): { name: string; installPath: string }[] {
  let cfg: { plugins?: Record<string, Array<{ installPath?: string }>> }
  try {
    cfg = JSON.parse(readFileSync(join(homedir(), '.claude/plugins/installed_plugins.json'), 'utf8'))
  } catch {
    return []
  }
  let flags: Record<string, boolean> = {}
  try {
    flags = JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf8')).enabledPlugins ?? {}
  } catch {}
  const out: { name: string; installPath: string }[] = []
  for (const [key, arr] of Object.entries(cfg.plugins ?? {})) {
    if (flags[key] === false) {
      continue // explicitly disabled
    }
    const inst = Array.isArray(arr) ? arr[0] : undefined
    if (inst?.installPath) {
      out.push({ name: key.split('@')[0]!, installPath: inst.installPath })
    }
  }
  return out
}

// `failed` = plugins whose `plugin details` call errored/timed out. The caller needs it:
// silently publishing only the survivors strips most of the bot's commands.
export async function discoverGlobalSkills(): Promise<{ skills: Skill[]; failed: number }> {
  const plugins = enabledPlugins()
  const userSkills = join(homedir(), '.claude/skills')
  const idx = descIndex([userSkills, ...plugins.map(p => p.installPath)])
  const names = new Set<string>()
  let failed = 0
  await Promise.all(
    plugins.map(async p => {
      try {
        const { stdout } = await pexec(claudeBin(), ['plugin', 'details', p.name], { timeout: 20_000 })
        for (const n of parseSkillsLine(stdout)) {
          names.add(n)
        }
      } catch (e) {
        failed++
        console.log(`plugin details ${p.name}: ${e}`)
      }
    }),
  )
  // user skills-dir entries are invocable on their own (name@skills-dir)
  for (const f of walkSkillMd(userSkills, 2)) {
    const nm = frontmatterField(readFileSync(f, 'utf8').slice(0, 8000), 'name')
    if (nm) {
      names.add(nm)
    }
  }
  return { skills: [...names].sort().map(name => ({ name, description: idx.get(name) ?? name })), failed }
}

export function discoverProjectSkills(dir: string): Skill[] {
  const out: Skill[] = []
  for (const f of walkSkillMd(join(dir, '.claude', 'skills'), 2)) {
    let src: string
    try {
      src = readFileSync(f, 'utf8').slice(0, 8000)
    } catch {
      continue
    }
    const name = frontmatterField(src, 'name')
    if (name) {
      out.push({ name, description: frontmatterField(src, 'description') ?? name })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ── self-test ──
if (import.meta.main) {
  const assert = (c: boolean, m: string) => {
    if (!c) {
      throw new Error(`FAIL: ${m}`)
    }
  }
  assert(mangleCmd('deep-research') === 'deep_research', 'hyphen→underscore')
  assert(mangleCmd('claude-mem:mem-search') === 'claude_mem_mem_search', 'colon→underscore')
  assert(mangleCmd('a'.repeat(40)).length === 32, 'truncated to 32')
  assert(parseSkillsLine('  Skills (2)  a, b-c\n  Agents (0)').join(',') === 'a,b-c', 'parse skills line')
  assert(parseSkillsLine('no skills here').length === 0, 'no skills line')
  // content-less Skills line must NOT bleed into the following Agents line
  assert(parseSkillsLine('  Skills (0)  \n  Agents (1)  code-simplifier').length === 0, 'empty skills, no bleed')
  const fm = '---\nname: foo\ndescription: bar baz\ntools: x\n---\n# body'
  assert(frontmatterField(fm, 'name') === 'foo', 'fm name')
  assert(frontmatterField(fm, 'description') === 'bar baz', 'fm desc')
  const block = '---\nname: foo\ndescription: >-\n  line one\n  line two\ntools: x\n---'
  assert(frontmatterField(block, 'description') === 'line one line two', 'fm block scalar')
  assert(tgDescription('a\n b   c') === 'a b c', 'tg desc collapse')
  assert(tgDescription('x'.repeat(300)).length === 256, 'tg desc truncate')
  console.log('skills.ts self-test OK')
  const g = await discoverGlobalSkills()
  console.log('global skills:', g.skills.length, 'failed plugins:', g.failed)
}
