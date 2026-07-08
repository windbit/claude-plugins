#!/usr/bin/env bun
// Hub: the single bot poller. Routing: chat/topic key → bindings.json → project dir
// → live sessions with that cwd. Bindings are created by /bind,/unbind,/allow from
// Telegram (admins from TELEGRAM_ADMINS).
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, statSync, realpathSync, chmodSync,
} from 'fs'
import { join, extname, sep, basename } from 'path'
import { homedir } from 'os'
import type { Socket } from 'bun'

import { STATE_DIR, ENV_FILE, INBOX_DIR, PID_FILE, SOCK_PATH } from './paths'
import { messageKey, keyToTarget, targetFor } from './bindings'
import {
  loadBindings, saveBindings, keysForDir, resolveProjectDir, type BindingEntry,
} from './registry'
import { encode, makeLineDecoder, type StubToHub, type HubToStub, type SessionInfo } from './protocol'
import { Router } from './router'
import { chunk, MAX_CHUNK_LIMIT, MAX_ATTACHMENT_BYTES, PHOTO_EXTS } from './chunk'
import {
  parseOpsCommand, sendKeys, typeLine, restartSession, alive,
  hasTmuxSession, ensureTmuxSession, buildLaunch, shellQuote, ackStartupPrompts,
  type OpsCommand,
} from './tmux-ops'
import { claudePidsInDir } from './proc'
import { readLimits, formatLimits } from './limits'
import { rmQuiet } from './util'

const log = (s: string) => process.stderr.write(`telegram hub: ${s}\n`)

// token and admins from state .env; the real env wins
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2]
    }
  }
} catch {} // no .env file — token may come from the real env
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  log(`TELEGRAM_BOT_TOKEN required — set in ${ENV_FILE}`)
  process.exit(1)
}
const ADMINS = (process.env.TELEGRAM_ADMINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
if (ADMINS.length === 0) {
  log(`WARNING: TELEGRAM_ADMINS is empty — nobody can bind or converse`)
}
const isAdmin = (id: string) => ADMINS.includes(id)

// base for /bind <name>; absolute paths and ~/… still work
const PROJECTS_DIR = process.env.TELEGRAM_PROJECTS_DIR || join(homedir(), 'projects')

// kill a zombie poller (incl. the old plugin) — one getUpdates per token
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0)
    log(`replacing stale poller pid=${stale}`)
    process.kill(stale, 'SIGTERM')
  }
} catch {} // no pid file, or the process is already gone
writeFileSync(PID_FILE, String(process.pid))

process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

const SPAWN_LOCK = join(STATE_DIR, 'hub.spawnlock')
const MAX_409_ATTEMPTS = 8
const MAX_BACKOFF_MS = 15_000

const bot = new Bot(TOKEN)
let botUsername = ''

const router = new Router<Socket<undefined>>()
const feeders = new Map<Socket<undefined>, (chunk: string) => void>()

function send(sock: Socket<undefined>, msg: HubToStub): void {
  try {
    sock.write(encode(msg))
  } catch (e) {
    log(`socket write failed: ${e}`)
  }
}

type PendingPermission = {
  conn: Socket<undefined>
  tool_name: string
  description: string
  input_preview: string
}
const pendingPermissions = new Map<string, PendingPermission>()
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

function resolvePermission(request_id: string, behavior: 'allow' | 'deny'): boolean {
  const p = pendingPermissions.get(request_id)
  if (!p) {
    return false
  }
  pendingPermissions.delete(request_id)
  send(p.conn, { op: 'event', kind: 'permission', request_id, behavior })
  return true
}

// a session's outbound is limited to the chats of its own keys
function ownKeys(conn: Socket<undefined>): string[] {
  const cwd = router.get(conn)?.cwd
  return cwd ? keysForDir(loadBindings(), cwd) : []
}

async function handleRpc(
  conn: Socket<undefined>,
  method: string,
  params: Record<string, unknown>,
): Promise<string> {
  switch (method) {
    case 'reply':
      return doReply(conn, params)
    case 'react':
      return doReact(conn, params)
    case 'edit_message':
      return doEdit(conn, params)
    case 'download_attachment':
      return doDownload(params)
    case 'permission_request':
      return doPermissionRequest(conn, params)
    default:
      throw new Error(`unknown rpc method: ${method}`)
  }
}

function assertBoundChat(conn: Socket<undefined>, chat_id: string): void {
  if (!ownKeys(conn).some(k => keyToTarget(k).chat_id === chat_id)) {
    throw new Error(`chat ${chat_id} is not bound to this session's project`)
  }
}

async function doReply(conn: Socket<undefined>, params: Record<string, unknown>): Promise<string> {
  const target = targetFor(
    ownKeys(conn),
    params.chat_id as string | undefined,
    params.thread_id as string | undefined,
  )
  assertBoundChat(conn, target.chat_id)
  const text = params.text as string
  const reply_to = params.reply_to != null ? Number(params.reply_to) : undefined
  const files = (params.files as string[] | undefined) ?? []
  const parseMode = params.format === 'markdownv2' ? ('MarkdownV2' as const) : undefined

  for (const f of files) {
    assertSendable(f)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
    }
  }

  const chunks = chunk(text, MAX_CHUNK_LIMIT, 'length')
  // thread on EVERY send — otherwise chunks/files without reply_to land in General
  const threadOpt = target.thread_id != null ? { message_thread_id: target.thread_id } : {}
  const sentIds: number[] = []
  try {
    for (let i = 0; i < chunks.length; i++) {
      const sent = await bot.api.sendMessage(target.chat_id, chunks[i], {
        ...threadOpt,
        ...(reply_to != null && i === 0 ? { reply_parameters: { message_id: reply_to } } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      })
      sentIds.push(sent.message_id)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
  }
  for (const f of files) {
    const input = new InputFile(f)
    const opts = {
      ...threadOpt,
      ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
    }
    const sent = PHOTO_EXTS.has(extname(f).toLowerCase())
      ? await bot.api.sendPhoto(target.chat_id, input, opts)
      : await bot.api.sendDocument(target.chat_id, input, opts)
    sentIds.push(sent.message_id)
  }
  return sentIds.length === 1
    ? `sent (id: ${sentIds[0]})`
    : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
}

async function doReact(conn: Socket<undefined>, params: Record<string, unknown>): Promise<string> {
  const chat_id = params.chat_id as string
  assertBoundChat(conn, chat_id)
  await bot.api.setMessageReaction(chat_id, Number(params.message_id), [
    { type: 'emoji', emoji: params.emoji as ReactionTypeEmoji['emoji'] },
  ])
  return 'reacted'
}

async function doEdit(conn: Socket<undefined>, params: Record<string, unknown>): Promise<string> {
  const chat_id = params.chat_id as string
  assertBoundChat(conn, chat_id)
  const parseMode = params.format === 'markdownv2' ? ('MarkdownV2' as const) : undefined
  const edited = await bot.api.editMessageText(
    chat_id,
    Number(params.message_id),
    params.text as string,
    ...(parseMode ? [{ parse_mode: parseMode }] : []),
  )
  const id = typeof edited === 'object' ? edited.message_id : params.message_id
  return `edited (id: ${id})`
}

async function doDownload(params: Record<string, unknown>): Promise<string> {
  const file = await bot.api.getFile(params.file_id as string)
  if (!file.file_path) {
    throw new Error('Telegram returned no file_path — file may have expired')
  }
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

function doPermissionRequest(conn: Socket<undefined>, params: Record<string, unknown>): string {
  const { request_id, tool_name, description, input_preview } = params as Record<string, string>
  pendingPermissions.set(request_id, { conn, tool_name, description, input_preview })
  const keyboard = new InlineKeyboard()
    .text('See more', `perm:more:${request_id}`)
    .text('✅ Allow', `perm:allow:${request_id}`)
    .text('❌ Deny', `perm:deny:${request_id}`)
  for (const chat_id of ADMINS) {
    void bot.api
      .sendMessage(chat_id, `🔐 Permission: ${tool_name}`, { reply_markup: keyboard })
      .catch(e => log(`permission_request send to ${chat_id} failed: ${e}`))
  }
  return 'relayed'
}

// reply must never be able to send channel state (token, bindings.json)
function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

rmQuiet(SOCK_PATH)
Bun.listen<undefined>({
  unix: SOCK_PATH,
  socket: {
    open(sock) {
      feeders.set(sock, makeLineDecoder<StubToHub>(
        msg => void handleStubMessage(sock, msg),
        e => log(`bad message from stub: ${e}`),
      ))
    },
    data(sock, data) {
      feeders.get(sock)?.(data.toString())
    },
    close(sock) {
      router.unsubscribe(sock)
      feeders.delete(sock)
      for (const [id, p] of pendingPermissions) {
        if (p.conn === sock) {
          pendingPermissions.delete(id)
        }
      }
      log(`stub disconnected (${router.size()} left)`)
    },
    error(_sock, err) {
      log(`stub socket error: ${err}`)
    },
  },
})
chmodSync(SOCK_PATH, 0o600)
log(`listening on ${SOCK_PATH}`)

async function handleStubMessage(sock: Socket<undefined>, msg: StubToHub): Promise<void> {
  if (msg.op === 'subscribe') {
    router.subscribe(sock, msg.session)
    learnCmdline(msg.session)
    log(`subscribe: cwd=${msg.session.cwd ?? '-'} pane=${msg.session.pane ?? '-'}`)
    return
  }
  if (msg.op === 'rpc') {
    try {
      const result = await handleRpc(sock, msg.method, msg.params)
      send(sock, { op: 'result', id: msg.id, ok: true, result })
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err)
      send(sock, { op: 'result', id: msg.id, ok: false, error: e })
    }
  }
}

// a live session's argv is remembered in its bindings — /resume relaunches with the same flags
function learnCmdline(session: SessionInfo): void {
  if (!session.cwd || !session.cmdline?.length) {
    return
  }
  const reg = loadBindings()
  let changed = false
  for (const k of keysForDir(reg, session.cwd)) {
    if (JSON.stringify(reg[k].cmdline) !== JSON.stringify(session.cmdline)) {
      reg[k].cmdline = session.cmdline
      changed = true
    }
  }
  if (changed) {
    saveBindings(reg)
  }
}

type AttachmentMeta = { kind: string; file_id: string; size?: number; mime?: string; name?: string }

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

type Inbound = {
  ctx: Context
  text: string
  downloadImage?: () => Promise<string | undefined>
  attachment?: AttachmentMeta
}

async function handleInbound({ ctx, text, downloadImage, attachment }: Inbound): Promise<void> {
  const from = ctx.from
  const chat = ctx.chat
  if (!from || !chat) {
    return
  }
  const senderId = String(from.id)
  const chat_id = String(chat.id)
  const msgId = ctx.message?.message_id
  const threadId = ctx.message?.message_thread_id
  const key = messageKey({ chatType: chat.type, chatId: chat_id, threadId })

  // a text permission reply ("yes xxxxx") isn't routed — it goes to the request_id owner
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch && isAdmin(senderId)) {
    const ok = resolvePermission(
      permMatch[2]!.toLowerCase(),
      permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
    )
    if (msgId != null) {
      const emoji = !ok ? '🤷‍♂️' : permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
      void bot.api
        .setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }])
        .catch(() => {})
    }
    return
  }

  const ops = parseOpsCommand(text)
  if (ops && (!ops.bot || ops.bot.toLowerCase() === botUsername.toLowerCase())) {
    await handleOps({ cmd: ops.cmd, arg: ops.arg, key, chat_id, threadId, senderId })
    return
  }

  const binding = loadBindings()[key]
  if (!binding) {
    log(`drop (unbound): key=${key} from=${senderId} text=${text.slice(0, 60)}`)
    return
  }
  if (!isAdmin(senderId) && !binding.allow?.includes(senderId)) {
    log(`drop (not allowed): key=${key} from=${senderId}`)
    return
  }
  const conns = router.byDir(binding.dir)
  if (conns.length === 0) {
    log(`drop (no live session for ${binding.dir}): key=${key} — /resume to bring it up`)
    return
  }

  log(`deliver: ${key} → ${binding.dir} (${conns.length} session${conns.length > 1 ? 's' : ''})`)
  // 👀 = "received" ack: the reply may lag if the session is busy
  if (msgId != null) {
    void bot.api
      .setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: '👀' }])
      .catch(() => {})
  }
  // thread_id is required, otherwise typing goes to General instead of the topic
  void bot.api.sendChatAction(chat_id, 'typing', threadId != null ? { message_thread_id: threadId } : {}).catch(() => {})
  const imagePath = downloadImage ? await downloadImage() : undefined
  const meta: Record<string, string> = {
    chat_id,
    ...(msgId != null ? { message_id: String(msgId) } : {}),
    user: from.username ?? senderId,
    user_id: senderId,
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    ...(threadId != null ? { topic_id: String(threadId) } : {}),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment
      ? {
          attachment_kind: attachment.kind,
          attachment_file_id: attachment.file_id,
          ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
          ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
          ...(attachment.name ? { attachment_name: attachment.name } : {}),
        }
      : {}),
  }
  for (const conn of conns) {
    send(conn, { op: 'event', kind: 'message', content: text, meta })
  }
}

// bind/unbind/allow — admins only; everything else — admins and the binding's allow users
type OpsRequest = {
  cmd: OpsCommand
  arg?: string
  key: string
  chat_id: string
  threadId?: number
  senderId: string
}

async function handleOps({ cmd, arg, key, chat_id, threadId, senderId }: OpsRequest): Promise<void> {
  const threadOpt = threadId != null ? { message_thread_id: threadId } : {}
  const say = (text: string) => bot.api.sendMessage(chat_id, text, threadOpt).catch(() => {})
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const sayHtml = (html: string) =>
    bot.api.sendMessage(chat_id, html, { ...threadOpt, parse_mode: 'HTML' }).catch(() => {})
  const reg = loadBindings()
  const binding: BindingEntry | undefined = reg[key]

  if (cmd === 'bind' || cmd === 'unbind' || cmd === 'allow') {
    if (!isAdmin(senderId)) {
      return
    }
    if (cmd === 'bind') {
      if (!arg) {
        void say(`usage: /bind <folder under ${PROJECTS_DIR} or absolute path>`)
        return
      }
      try {
        const dir = resolveProjectDir(arg, PROJECTS_DIR)
        reg[key] = { dir, ...(binding?.allow ? { allow: binding.allow } : {}) }
        saveBindings(reg)
        void say(`🔗 ${key} → ${dir}\nNow /new or /resume to start the session.`)
      } catch (e) {
        void say(`bind failed: ${e instanceof Error ? e.message : e}`)
      }
      return
    }
    if (cmd === 'unbind') {
      if (!binding) {
        void say('not bound')
        return
      }
      delete reg[key]
      saveBindings(reg)
      void say(`⛓️‍💥 unbound (was ${binding.dir})`)
      return
    }
    // allow
    if (!binding) {
      void say('bind first: /bind <folder>')
      return
    }
    if (!arg) {
      void say(`allow: [${binding.allow?.join(', ') ?? ''}]\nusage: /allow <telegram user id …> (remove by editing bindings.json)`)
      return
    }
    const ids = arg.split(/[\s,]+/).filter(s => /^\d+$/.test(s))
    if (ids.length === 0) {
      void say('usage: /allow <telegram user id …>')
      return
    }
    binding.allow = [...new Set([...(binding.allow ?? []), ...ids])]
    saveBindings(reg)
    void say(`✅ allow: [${binding.allow.join(', ')}]`)
    return
  }

  if (!isAdmin(senderId) && !binding?.allow?.includes(senderId)) {
    return
  }

  const live = binding ? router.byDir(binding.dir) : []
  const session = live.length > 0 ? router.get(live[0]) : undefined

  if (cmd === 'status') {
    if (!binding) {
      void say(`📊 ${key}\nnot bound — /bind <folder> (admin)`)
      return
    }
    const lines = [`📊 ${key}`, `dir: ${binding.dir}`]
    if (session) {
      const pidState = session.pid
        ? alive(session.pid) ? `alive (pid ${session.pid})` : `DEAD (pid ${session.pid})`
        : 'pid unknown'
      lines.push(`claude: connected, ${pidState}`, `tmux pane: ${session.pane ?? 'not in tmux'}`)
    } else {
      lines.push('claude: not connected')
      const name = basename(binding.dir)
      lines.push(`tmux "${name}": ${(await hasTmuxSession(name)) ? 'exists' : 'no session'}`)
      lines.push('→ /resume to bring it up')
    }
    const limits = readLimits(binding.dir)
    if (limits) {
      lines.push(...formatLimits(limits, Date.now()))
    }
    if (binding.allow?.length) {
    lines.push(`allow: [${binding.allow.join(', ')}]`)
  }
    void say(lines.join('\n'))
    return
  }

  if (!binding) {
    void say('not bound — /bind <folder> first')
    return
  }

  if (cmd === 'compact' || cmd === 'esc' || cmd === 'restart') {
    if (live.length === 0) {
      void say('⚙️ no live session — try /resume')
      return
    }
    for (const conn of live) {
      const s = router.get(conn)
      if (!s?.pane) {
        void say('⚙️ session is not in tmux — cannot control it')
        continue
      }
      try {
        if (cmd === 'compact') {
          await sendKeys(s.pane, '/compact', 'Enter')
          void say('⚙️ /compact sent')
        } else if (cmd === 'esc') {
          await sendKeys(s.pane, 'Escape')
          void say('⚙️ Esc sent')
        } else {
          if (!s.pid || !s.cmdline?.length) {
            void say('⚙️ restart unavailable — claude process not identified')
            continue
          }
          void say('♻️ restarting session…')
          void restartSession(s.pane, s.pid, s.cmdline, log)
            .then(() => say('♻️ relaunch sent'))
            .catch(e => say(`♻️ restart failed: ${e}`))
        }
      } catch (e) {
        void say(`⚙️ ${cmd} failed: ${e}`)
      }
    }
    return
  }

  // resume | new
  if (live.length > 0) {
    void say(`⚙️ session already connected (${session?.pane ?? 'no tmux'}) — use /restart or /compact`)
    return
  }
  // A foreign claude in this dir (no channels, invisible to the hub): /resume=--continue
  // would fork its conversation as a duplicate. Don't spawn — ask the operator to sort it out.
  const foreign = claudePidsInDir(binding.dir)
  if (foreign.length > 0) {
    void say(
      `⚠️ claude is already running in this folder (pid ${foreign.join(', ')}), but without ` +
        `channels — the hub doesn't manage it. Not starting a second one: /resume (--continue) ` +
        `would fork its conversation.\nClose that session (or relaunch it with the dev channel), then retry.`,
    )
    return
  }
  const name = basename(binding.dir)
  try {
    const created = await ensureTmuxSession(name, binding.dir)
    const launch = buildLaunch(binding.cmdline, cmd === 'resume' ? 'resume' : 'new')
    if (!created) {
      // the active pane of an existing tmux session should hold a shell — operator's call
      void say(`⚙️ tmux "${name}" exists — typing launch into its active pane`)
    } else {
      void say(`⚙️ tmux "${name}" created in ${binding.dir}`)
    }
    await typeLine(`=${name}:`, `cd ${shellQuote([binding.dir])} && ${launch}`)
    void sayHtml(`🚀 ${cmd === 'resume' ? 'resuming' : 'starting fresh'}: <code>${esc(launch)}</code>`)
    void ackStartupPrompts(`=${name}:`, log)
  } catch (e) {
    void say(`⚙️ ${cmd} failed: ${e}`)
  }
}

bot.on('message:text', async ctx => handleInbound({ ctx, text: ctx.message.text }))

bot.on('message:photo', async ctx => {
  const downloadImage = async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) {
        return undefined
      }
      const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      log(`photo download failed: ${err}`)
      return undefined
    }
  }
  await handleInbound({ ctx, text: ctx.message.caption ?? '(photo)', downloadImage })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  await handleInbound({
    ctx,
    text: ctx.message.caption ?? `(document: ${name ?? 'file'})`,
    attachment: { kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name },
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  await handleInbound({
    ctx,
    text: ctx.message.caption ?? '(voice message)',
    attachment: { kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type },
  })
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  await handleInbound({
    ctx,
    text: ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`,
    attachment: { kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name },
  })
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  await handleInbound({
    ctx,
    text: ctx.message.caption ?? '(video)',
    attachment: {
      kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type,
      name: safeName(video.file_name),
    },
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound({
    ctx,
    text: '(video note)',
    attachment: { kind: 'video_note', file_id: vn.file_id, size: vn.file_size },
  })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  await handleInbound({
    ctx,
    text: `(sticker${sticker.emoji ? ` ${sticker.emoji}` : ''})`,
    attachment: { kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size },
  })
})

bot.on('callback_query:data', async ctx => {
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(ctx.callbackQuery.data)
  if (!m) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  if (!isAdmin(String(ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) {
      await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
      return
    }
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(details.input_preview), null, 2)
    } catch {
      prettyInput = details.input_preview
    }
    const expanded =
      `🔐 Permission: ${details.tool_name}\n\ntool_name: ${details.tool_name}\n` +
      `description: ${details.description}\ninput_preview:\n${prettyInput}`
    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `perm:allow:${request_id}`)
      .text('❌ Deny', `perm:deny:${request_id}`)
    await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  const ok = resolvePermission(request_id, behavior as 'allow' | 'deny')
  const label = !ok ? '🤷‍♂️ Session gone' : behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) {
    await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
  }
})

bot.catch(err => log(`handler error (polling continues): ${err.error}`))

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  log('shutting down')
  try {
    if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) {
      rmSync(PID_FILE)
    }
  } catch {}
  rmQuiet(SOCK_PATH)
  rmQuiet(SPAWN_LOCK)
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          botUsername = info.username
          rmQuiet(SPAWN_LOCK)
          log(`polling as @${info.username}`)
          void bot.api.setMyCommands([
            { command: 'status', description: 'Session status (dir/tmux/claude)' },
            { command: 'resume', description: 'Bring session up (--continue)' },
            { command: 'new', description: 'Start a fresh session' },
            { command: 'compact', description: 'Send /compact to the session' },
            { command: 'esc', description: 'Interrupt current turn' },
            { command: 'restart', description: 'Graceful session restart' },
            { command: 'bind', description: 'Bind this chat/topic to a project folder (admin)' },
            { command: 'unbind', description: 'Remove binding (admin)' },
            { command: 'allow', description: 'Allow a user for this binding (admin)' },
          ]).catch(() => {})
        },
      })
      return
    } catch (err) {
      if (shuttingDown) {
        return
      }
      if (err instanceof Error && err.message === 'Aborted delay') {
        return
      }
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && attempt >= MAX_409_ATTEMPTS) {
        log(`409 Conflict persists after ${attempt} attempts — another poller holds the token. Exiting.`)
        process.exit(1)
      }
      const delay = Math.min(1000 * attempt, MAX_BACKOFF_MS)
      log(`${is409 ? '409 Conflict' : `polling error: ${err}`}, retrying in ${delay / 1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()
