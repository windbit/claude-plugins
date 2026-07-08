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
  capturePane, type OpsCommand,
} from './tmux-ops'
import { claudePidsInDir } from './proc'
import { readLimits, formatLimits } from './limits'
import { rmQuiet } from './util'
import { parsePicker, checkedIndexes, type Picker } from './picker'
import { buildKeyboard, parseCallback } from './picker-drive'
import {
  loadTrustedGroups, isExcludedTopic, slugFromTopicName, type TrustedGroupConfig,
} from './trusted-groups'
import { resolveModeDir } from './dir-resolve'
import { jsonlMtimes, captureNewSessionId } from './session-id'

const log = (s: string) => process.stderr.write(`telegram hub: ${s}\n`)

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Shorten a $HOME-relative path to ~/… for display.
const HOME = homedir()
function tildePath(p: string): string {
  return p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p
}

// HTML <code> with a home-shortened, escaped path.
function codePath(p: string): string {
  return `<code>${escHtml(tildePath(p))}</code>`
}

// "typing…" hint — shown whenever the agent is handed input to work on.
function typing(chatId: string, threadId?: number): void {
  void bot.api
    .sendChatAction(chatId, 'typing', threadId != null ? { message_thread_id: threadId } : {})
    .catch(() => {})
}

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
const SCREEN_POLL_MS = 1500
const CUSTOM_TIMEOUT_MS = 120_000

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
  const s = router.get(conn)
  if (s?.bindingKeys?.length) {
    return s.bindingKeys
  }
  return s?.cwd ? keysForDir(loadBindings(), s.cwd) : []
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
    .text('Подробнее', `perm:more:${request_id}`)
    .text('✅ Разрешить', `perm:allow:${request_id}`)
    .text('❌ Отклонить', `perm:deny:${request_id}`)
  for (const chat_id of ADMINS) {
    void bot.api
      .sendMessage(chat_id, `🔐 <b>Запрос разрешения</b>\n<code>${escHtml(tool_name)}</code>`, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
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

// ── picker bridge: forward Claude Code TUI pickers to Telegram buttons ──
type ActivePicker = {
  chatId: string
  threadId?: number
  msgId: number
  hash: string
  token: string
  picker: Picker
}
const activePickers = new Map<string, ActivePicker>() // key = pane
const awaitingCustom = new Map<string, { chatId: string; threadId?: number; at: number }>()

function bindingAllows(chatId: string, senderId: string): boolean {
  const reg = loadBindings()
  for (const [key, entry] of Object.entries(reg)) {
    if (keyToTarget(key).chat_id === chatId && entry.allow?.includes(senderId)) {
      return true
    }
  }
  return false
}

function pickerChatFor(session: SessionInfo): { chatId: string; threadId?: number } | undefined {
  const key = session.bindingKeys?.[0] ?? (session.cwd ? keysForDir(loadBindings(), session.cwd)[0] : undefined)
  if (!key) {
    return undefined
  }
  const t = keyToTarget(key)
  return { chatId: t.chat_id, ...(t.thread_id != null ? { threadId: t.thread_id } : {}) }
}

function kbFrom(picker: Picker, token: string, checked: number[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const row of buildKeyboard(picker, token, checked).buttons) {
    for (const b of row) {
      kb.text(b.text, b.data)
    }
    kb.row()
  }
  return kb
}

function paneByToken(token: string): string | undefined {
  for (const [pane, ap] of activePickers) {
    if (ap.token === token) {
      return pane
    }
  }
  return undefined
}

// folder-trust / dev-channel prompts also carry "Esc to cancel"; the hub auto-acks
// them (ackStartupPrompts), so they must not surface as Telegram pickers.
const AUTO_ACK_MARKERS = ['I trust this folder', 'I am using this for local development']

function isAutoAckPrompt(picker: Picker): boolean {
  return picker.options.some(o => AUTO_ACK_MARKERS.some(m => o.label.includes(m)))
}

function pickerTitleHtml(ap: ActivePicker): string {
  return `❓ <b>${escHtml(ap.picker.title || 'Вопрос')}</b>`
}

function resolvedText(ap: ActivePicker, answer: string): string {
  return `${pickerTitleHtml(ap)}\n\n${answer}`
}

async function resolvePickerMessage(ap: ActivePicker, answer: string): Promise<void> {
  await bot.api
    .editMessageText(ap.chatId, ap.msgId, resolvedText(ap, answer), { parse_mode: 'HTML' })
    .catch(() => {})
}

async function detectPicker(pane: string, session: SessionInfo, text: string): Promise<void> {
  const picker = parsePicker(text)
  const existing = activePickers.get(pane)
  if (!picker || isAutoAckPrompt(picker)) {
    if (existing) {
      // closed without a TG tap (answered in the TUI) — the answer is unknown to us
      void resolvePickerMessage(existing, '<i>отвечено в терминале</i>')
      activePickers.delete(pane)
    }
    return
  }
  if (existing && existing.hash === picker.hash) {
    return
  }
  const target = pickerChatFor(session)
  if (!target) {
    return
  }
  const sent = await bot.api
    .sendMessage(target.chatId, `❓ <b>${escHtml(picker.title || 'Question')}</b>`, {
      ...(target.threadId != null ? { message_thread_id: target.threadId } : {}),
      parse_mode: 'HTML',
      reply_markup: kbFrom(picker, picker.hash, checkedIndexes(text)),
    })
    .catch(() => undefined)
  if (sent) {
    log(`picker sent: pane=${pane} mode=${picker.mode} opts=${picker.options.length} title="${picker.title.slice(0, 40)}"`)
    activePickers.set(pane, {
      chatId: target.chatId,
      ...(target.threadId != null ? { threadId: target.threadId } : {}),
      msgId: sent.message_id,
      hash: picker.hash,
      token: picker.hash,
      picker,
    })
  }
}

// One capture per live pane per tick, fanned out to screen detectors.
async function pollScreens(): Promise<void> {
  const seen = new Set<string>()
  for (const conn of router.all()) {
    const s = router.get(conn)
    if (!s?.pane || !s.cwd) {
      continue
    }
    seen.add(s.pane)
    const text = await capturePane(s.pane).catch(() => '')
    await detectPicker(s.pane, s, text)
  }
  for (const pane of [...activePickers.keys()]) {
    if (!seen.has(pane)) {
      activePickers.delete(pane)
    }
  }
}
setInterval(() => void pollScreens(), SCREEN_POLL_MS)

async function handlePickCallback(
  ctx: Context,
  pick: NonNullable<ReturnType<typeof parseCallback>>,
): Promise<void> {
  const pane = paneByToken(pick.token)
  const ap = pane ? activePickers.get(pane) : undefined
  if (!pane || !ap) {
    await ctx.answerCallbackQuery({ text: 'Пикер закрыт' }).catch(() => {})
    return
  }
  const senderId = String(ctx.from!.id)
  if (!isAdmin(senderId) && !bindingAllows(ap.chatId, senderId)) {
    await ctx.answerCallbackQuery({ text: 'Нет доступа' }).catch(() => {})
    return
  }
  const action = pick.action
  log(`pick: pane=${pane} from=${senderId} action=${action.kind}${action.kind === 'opt' ? action.index : ''}`)
  const labelOf = (i: number) => ap.picker.options.find(o => o.index === i)?.label ?? String(i)
  if (action.kind === 'opt' && ap.picker.mode === 'single') {
    await sendKeys(pane, String(action.index))
    await resolvePickerMessage(ap, `✅ <b>${escHtml(labelOf(action.index))}</b>`)
    activePickers.delete(pane)
    typing(ap.chatId, ap.threadId) // agent resumes on the answer
    await ctx.answerCallbackQuery({ text: 'Выбрано' }).catch(() => {})
  } else if (action.kind === 'opt') {
    await sendKeys(pane, String(action.index)) // multi: toggle checkbox
    await ctx.answerCallbackQuery().catch(() => {})
    const text = await capturePane(pane).catch(() => '')
    await ctx
      .editMessageReplyMarkup({ reply_markup: kbFrom(ap.picker, ap.token, checkedIndexes(text)) })
      .catch(() => {})
  } else if (action.kind === 'submit') {
    const chosen = checkedIndexes(await capturePane(pane).catch(() => '')).map(labelOf)
    await sendKeys(pane, 'Right') // → review screen
    await sendKeys(pane, '1') // Submit answers
    await resolvePickerMessage(ap, `✅ <b>${chosen.length ? escHtml(chosen.join(', ')) : '—'}</b>`)
    activePickers.delete(pane)
    typing(ap.chatId, ap.threadId) // agent resumes on the submitted answers
    await ctx.answerCallbackQuery({ text: 'Отправлено' }).catch(() => {})
  } else {
    // "Type something" is an inline-editable option: the digit navigates to it and
    // makes it editable; the user's text is typed straight in (no Enter yet — that
    // would decline). typeLine below fills the field and submits with Enter.
    if (ap.picker.customIndex != null) {
      await sendKeys(pane, String(ap.picker.customIndex))
    }
    awaitingCustom.set(pane, {
      chatId: ap.chatId,
      ...(ap.threadId != null ? { threadId: ap.threadId } : {}),
      at: Date.now(),
    })
    await ctx.answerCallbackQuery({ text: 'Пришли текст' }).catch(() => {})
    void bot.api
      .sendMessage(ap.chatId, '✍️ <b>Пришли ответ</b> сообщением.', {
        ...(ap.threadId != null ? { message_thread_id: ap.threadId } : {}),
        parse_mode: 'HTML',
      })
      .catch(() => {})
  }
}

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
  const keys = session.bindingKeys?.length ? session.bindingKeys : keysForDir(reg, session.cwd)
  for (const k of keys) {
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

// per-binding session lookup, falls back to dir (sessions from before bindingKeys existed)
function connsForBinding(key: string, dir: string): Socket<undefined>[] {
  const byKey = router.byBindingKey(key)
  return byKey.length > 0 ? byKey : router.byDir(dir)
}

async function waitForBinding(key: string, timeoutMs: number): Promise<Socket<undefined>[]> {
  const dir = loadBindings()[key]?.dir
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const conns = dir ? connsForBinding(key, dir) : router.byBindingKey(key)
    if (conns.length > 0) {
      return conns
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  return []
}

// dir alone collides when several bindings share it (mode: shared) — tmux session is per-binding
function sessionName(key: string, dir: string): string {
  return `${basename(dir)}--${key.replace(/[^\w.-]/g, '-')}`
}

function trackedPids(): Set<number> {
  const out = new Set<number>()
  for (const conn of router.all()) {
    const pid = router.get(conn)?.pid
    if (pid) {
      out.add(pid)
    }
  }
  return out
}

// claude processes in `dir` the hub doesn't already track (mode: shared siblings don't count)
function foreignPidsInDir(dir: string): number[] {
  const tracked = trackedPids()
  return claudePidsInDir(dir).filter(pid => !tracked.has(pid))
}

// tmux+launch for a binding — shared by /resume,/new and auto-topic creation
async function spawnSession(
  key: string,
  binding: BindingEntry,
  mode: 'resume' | 'new',
  say: (html: string) => void,
): Promise<void> {
  const name = sessionName(key, binding.dir)
  const fresh = mode === 'new' || !binding.sessionId
  const before = fresh ? jsonlMtimes(binding.dir) : new Map<string, number>()
  try {
    const created = await ensureTmuxSession(name, binding.dir)
    const launch = buildLaunch(binding.cmdline, mode, binding.sessionId)
    say(
      created
        ? `🪟 tmux <code>${escHtml(name)}</code> создан в ${codePath(binding.dir)}.`
        : `🪟 tmux <code>${escHtml(name)}</code> уже есть — набираю запуск в его активный pane.`,
    )
    const envPrefix = `TELEGRAM_BINDING_KEYS=${shellQuote([key])}`
    await typeLine(`=${name}:`, `cd ${shellQuote([binding.dir])} && ${envPrefix} ${launch}`)
    say(`🚀 <b>${mode === 'resume' ? 'Возобновляю' : 'Запускаю заново'}</b>\n<code>${escHtml(launch)}</code>`)
    void ackStartupPrompts(`=${name}:`, log)
    if (fresh) {
      void captureNewSessionId(binding.dir, before, 60_000).then(id => {
        if (!id) {
          return
        }
        const reg = loadBindings()
        if (reg[key]) {
          reg[key].sessionId = id
          saveBindings(reg)
          log(`learned sessionId for ${key}: ${id}`)
        }
      })
    }
  } catch (e) {
    say(`⚠️ <b>${mode} не удалось</b>: ${escHtml(String(e))}`)
  }
}

// new forum topic in a trusted group → auto-bind + auto-start, no /bind needed
type PendingTopic = { cfg: TrustedGroupConfig; say: (html: string) => void; timer: ReturnType<typeof setTimeout> }
const pendingTopics = new Map<string, PendingTopic>()
const TOPIC_GRACE_MS = 4000

async function runAutoTopic(
  key: string,
  cfg: TrustedGroupConfig,
  branch: string,
  say: (html: string) => void,
): Promise<void> {
  const branchNote = cfg.mode === 'shared' ? '' : `, ветка <code>${escHtml(branch)}</code>`
  say(`⏳ Готовлю сессию (<code>${escHtml(cfg.mode)}</code>${branchNote})…`)
  try {
    const dir = await resolveModeDir(cfg, branch)
    const reg = loadBindings()
    reg[key] = { dir, ...(cfg.cmdline ? { cmdline: cfg.cmdline } : {}) }
    saveBindings(reg)
    await spawnSession(key, reg[key], 'new', say)
  } catch (e) {
    say(`⚠️ <b>Не удалось поднять сессию</b>: ${escHtml(String(e))}`)
  }
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

  // a message beat the auto-topic grace timer: it's an explicit branch name, not chat
  const pendingTopic = pendingTopics.get(key)
  if (pendingTopic) {
    clearTimeout(pendingTopic.timer)
    pendingTopics.delete(key)
    await runAutoTopic(key, pendingTopic.cfg, text.trim(), pendingTopic.say)
    return
  }

  // custom-answer text for a picker: a pane in this chat is waiting for free text
  for (const [pane, aw] of awaitingCustom) {
    if (aw.chatId !== chat_id) {
      continue
    }
    if (Date.now() - aw.at > CUSTOM_TIMEOUT_MS) {
      awaitingCustom.delete(pane)
      continue
    }
    if (isAdmin(senderId) || bindingAllows(chat_id, senderId)) {
      await typeLine(pane, text)
      typing(chat_id, threadId) // agent now processes the custom answer
      const ap = activePickers.get(pane)
      if (ap) {
        await resolvePickerMessage(ap, `✅ <b>${escHtml(text)}</b>`)
        activePickers.delete(pane)
      }
      awaitingCustom.delete(pane)
      return
    }
  }

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
  let conns = connsForBinding(key, binding.dir)
  const say = (html: string) =>
    void bot.api
      .sendMessage(chat_id, html, { ...(threadId != null ? { message_thread_id: threadId } : {}), parse_mode: 'HTML' })
      .catch(() => {})
  if (conns.length === 0) {
    log(`reviving: key=${key} dir=${binding.dir} — no live session for an inbound message`)
    await spawnSession(key, binding, binding.sessionId ? 'resume' : 'new', say)
    conns = await waitForBinding(key, 30_000)
    if (conns.length === 0) {
      say('⚠️ Сессия не подключилась вовремя — сообщение не доставлено, попробуй ещё раз.')
      return
    }
  }

  log(`deliver: ${key} → ${binding.dir} (${conns.length} session${conns.length > 1 ? 's' : ''})`)
  // 👀 = "received" ack: the reply may lag if the session is busy
  if (msgId != null) {
    void bot.api
      .setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: '👀' }])
      .catch(() => {})
  }
  // thread_id is required, otherwise typing goes to General instead of the topic
  typing(chat_id, threadId)
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
  const say = (html: string) =>
    bot.api.sendMessage(chat_id, html, { ...threadOpt, parse_mode: 'HTML' }).catch(() => {})
  const reg = loadBindings()
  const binding: BindingEntry | undefined = reg[key]

  if (cmd === 'bind' || cmd === 'unbind' || cmd === 'allow') {
    if (!isAdmin(senderId)) {
      return
    }
    if (cmd === 'bind') {
      if (!arg) {
        void say(`Использование: <code>/bind &lt;папка&gt;</code>\n\nИмя в ${codePath(PROJECTS_DIR)} или абсолютный путь.`)
        return
      }
      try {
        const dir = resolveProjectDir(arg, PROJECTS_DIR)
        reg[key] = { dir, ...(binding?.allow ? { allow: binding.allow } : {}) }
        saveBindings(reg)
        void say(`🔗 <b>Привязано</b>\n<code>${escHtml(key)}</code> → ${codePath(dir)}\n\nЗапусти через <code>/new</code> или <code>/resume</code>.`)
      } catch (e) {
        void say(`⚠️ <b>Не удалось привязать</b>: ${escHtml(e instanceof Error ? e.message : String(e))}`)
      }
      return
    }
    if (cmd === 'unbind') {
      if (!binding) {
        void say('Здесь ничего не привязано.')
        return
      }
      delete reg[key]
      saveBindings(reg)
      void say(`🔓 <b>Отвязано</b> <i>(было ${codePath(binding.dir)})</i>`)
      return
    }
    // allow
    if (!binding) {
      void say('Сначала привяжи: <code>/bind &lt;папка&gt;</code>')
      return
    }
    if (!arg) {
      const current = binding.allow?.length ? `<code>${escHtml(binding.allow.join(', '))}</code>` : '<i>никого</i>'
      void say(`👥 <b>Доступ</b>: ${current}\n\nИспользование: <code>/allow &lt;id …&gt;</code>\n<i>Убрать — правкой bindings.json.</i>`)
      return
    }
    const ids = arg.split(/[\s,]+/).filter(s => /^\d+$/.test(s))
    if (ids.length === 0) {
      void say('Использование: <code>/allow &lt;id …&gt;</code>')
      return
    }
    binding.allow = [...new Set([...(binding.allow ?? []), ...ids])]
    saveBindings(reg)
    void say(`✅ <b>Доступ</b>: <code>${escHtml(binding.allow.join(', '))}</code>`)
    return
  }

  if (!isAdmin(senderId) && !binding?.allow?.includes(senderId)) {
    return
  }

  const live = binding ? connsForBinding(key, binding.dir) : []
  const session = live.length > 0 ? router.get(live[0]) : undefined

  if (cmd === 'status') {
    if (!binding) {
      void say(`📊 <b>${escHtml(key)}</b>\n\n<i>Не привязано.</i> Привяжи через <code>/bind &lt;папка&gt;</code> (админ).`)
      return
    }
    const lines = [`📊 <b>${escHtml(key)}</b>`, `📁 ${codePath(binding.dir)}`, '']
    if (session) {
      const pidState = session.pid
        ? alive(session.pid) ? `жив <i>(pid ${session.pid})</i>` : `<b>мёртв</b> <i>(pid ${session.pid})</i>`
        : 'pid неизвестен'
      lines.push(`🟢 claude: подключён, ${pidState}`, `🪟 tmux: ${session.pane ? `<code>${escHtml(session.pane)}</code>` : '<i>не в tmux</i>'}`)
    } else {
      lines.push('⚪️ claude: не подключён')
      const name = sessionName(key, binding.dir)
      const tmuxState = (await hasTmuxSession(name)) ? 'есть' : 'нет сессии'
      lines.push(`🪟 tmux <code>${escHtml(name)}</code>: ${tmuxState}`, '', '→ <code>/resume</code> чтобы поднять')
    }
    const limits = readLimits(binding.dir)
    if (limits) {
      const parts = formatLimits(limits, Date.now())
      if (parts.length > 0) {
        lines.push('', ...parts.map(p => `<code>${escHtml(p)}</code>`))
      }
    }
    if (binding.allow?.length) {
      lines.push('', `👥 доступ: <code>${escHtml(binding.allow.join(', '))}</code>`)
    }
    void say(lines.join('\n'))
    return
  }

  if (!binding) {
    void say('Здесь ничего не привязано. Сначала <code>/bind &lt;папка&gt;</code>.')
    return
  }

  if (cmd === 'compact' || cmd === 'esc' || cmd === 'restart') {
    if (live.length === 0) {
      void say('⚠️ Нет живой сессии. Попробуй <code>/resume</code>.')
      return
    }
    for (const conn of live) {
      const s = router.get(conn)
      if (!s?.pane) {
        void say('⚠️ Сессия не в tmux — не могу ей управлять.')
        continue
      }
      try {
        if (cmd === 'compact') {
          await sendKeys(s.pane, '/compact', 'Enter')
          void say('🗜 <code>/compact</code> отправлен.')
        } else if (cmd === 'esc') {
          await sendKeys(s.pane, 'Escape')
          void say('⎋ <b>Esc</b> отправлен.')
        } else {
          if (!s.pid || !s.cmdline?.length) {
            void say('⚠️ Рестарт недоступен — не опознал процесс claude.')
            continue
          }
          void say('♻️ <b>Перезапускаю</b> сессию…')
          void restartSession(s.pane, s.pid, s.cmdline, log)
            .then(() => say('♻️ Перезапуск отправлен.'))
            .catch(e => say(`⚠️ Рестарт не удался: ${escHtml(String(e))}`))
        }
      } catch (e) {
        void say(`⚠️ <b>${escHtml(cmd)} не удалось</b>: ${escHtml(String(e))}`)
      }
    }
    return
  }

  // resume | new
  if (live.length > 0) {
    void say(`⚙️ Сессия уже подключена <i>(${session?.pane ? `<code>${escHtml(session.pane)}</code>` : 'не в tmux'})</i>.\n\nИспользуй <code>/restart</code> или <code>/compact</code>.`)
    return
  }
  const foreign = foreignPidsInDir(binding.dir)
  if (foreign.length > 0) {
    void say(
      `⚠️ <b>В этой папке уже работает claude</b> <i>(pid ${foreign.join(', ')})</i>, но без каналов — ` +
        `хаб им не управляет.\n\nВторую не поднимаю: <code>/resume</code> форкнул бы её беседу. ` +
        `Закрой ту сессию (или перезапусти её с dev-каналом) и повтори.`,
    )
    return
  }
  await spawnSession(key, binding, cmd === 'resume' ? 'resume' : 'new', html => void say(html))
}

bot.on('message:forum_topic_created', ctx => {
  const chat_id = String(ctx.chat.id)
  const cfg = loadTrustedGroups()[chat_id]
  if (!cfg) {
    return
  }
  const threadId = ctx.message.message_thread_id ?? ctx.message.message_id
  const topicName = ctx.message.forum_topic_created.name
  if (isExcludedTopic(cfg, threadId, topicName)) {
    return
  }
  const key = messageKey({ chatType: ctx.chat.type, chatId: chat_id, threadId })
  const say = (html: string) =>
    void bot.api
      .sendMessage(chat_id, html, { message_thread_id: threadId, parse_mode: 'HTML' })
      .catch(() => {})
  const timer = setTimeout(() => {
    pendingTopics.delete(key)
    void runAutoTopic(key, cfg, slugFromTopicName(topicName), say)
  }, TOPIC_GRACE_MS)
  pendingTopics.set(key, { cfg, say, timer })
})

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
  const pick = parseCallback(ctx.callbackQuery.data)
  if (pick) {
    await handlePickCallback(ctx, pick)
    return
  }
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(ctx.callbackQuery.data)
  if (!m) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  if (!isAdmin(String(ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: 'Нет прав' }).catch(() => {})
    return
  }
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) {
      await ctx.answerCallbackQuery({ text: 'Детали недоступны' }).catch(() => {})
      return
    }
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(details.input_preview), null, 2)
    } catch {
      prettyInput = details.input_preview
    }
    const expanded =
      `🔐 <b>Запрос разрешения</b>: <code>${escHtml(details.tool_name)}</code>\n\n` +
      `${escHtml(details.description)}\n\n<pre>${escHtml(prettyInput)}</pre>`
    const keyboard = new InlineKeyboard()
      .text('✅ Разрешить', `perm:allow:${request_id}`)
      .text('❌ Отклонить', `perm:deny:${request_id}`)
    await ctx.editMessageText(expanded, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  const ok = resolvePermission(request_id, behavior as 'allow' | 'deny')
  const label = !ok ? '🤷 Сессия ушла' : behavior === 'allow' ? '✅ Разрешено' : '❌ Отклонено'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) {
    await ctx.editMessageText(`${escHtml(msg.text)}\n\n<b>${label}</b>`, { parse_mode: 'HTML' }).catch(() => {})
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
            { command: 'status', description: 'Статус сессии (папка/tmux/claude/лимиты)' },
            { command: 'resume', description: 'Поднять сессию (--continue)' },
            { command: 'new', description: 'Запустить свежую сессию' },
            { command: 'compact', description: 'Отправить /compact в сессию' },
            { command: 'esc', description: 'Прервать текущий ход' },
            { command: 'restart', description: 'Аккуратный перезапуск сессии' },
            { command: 'bind', description: 'Привязать этот чат/топик к папке проекта (админ)' },
            { command: 'unbind', description: 'Снять привязку (админ)' },
            { command: 'allow', description: 'Дать доступ пользователю к этому биндингу (админ)' },
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
