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
import { messageKey, keyToTarget, targetFor, type Target } from './bindings'
import {
  loadBindings, saveBindings, keysForDir, resolveProjectDir, type BindingEntry,
} from './registry'
import { encode, makeLineDecoder, type StubToHub, type HubToStub, type SessionInfo } from './protocol'
import { Router } from './router'
import { chunk, MAX_CHUNK_LIMIT, MAX_ATTACHMENT_BYTES, PHOTO_EXTS } from './chunk'
import { mdToHtml } from './md-html'
import {
  parseOpsCommand, parseCompaction, parseContextPct, parseError, parseWorkflow, sendKeys, typeLine, selectOption, restartSession, stopSession, alive,
  hasTmuxSession, ensureTmuxSession, killTmuxSession, buildLaunch, shellQuote, ackStartupPrompts,
  capturePane, capturePaneAnsi, type OpsCommand,
} from './tmux-ops'
import { ansiToHtml } from './ansi-html'
import { claudePidsInDir } from './proc'
import { readLimits, formatLimits } from './limits'
import { rmQuiet } from './util'
import { parsePicker, checkedIndexes, parseResumeList, fnv1a, type Picker, type ResumeRow } from './picker'
import { buildKeyboard, parseCallback } from './picker-drive'
import {
  loadTrustedGroups, isExcludedTopic, slugFromTopicName, MODE_LABEL,
  type TrustedGroupConfig, type TrustedGroupMode,
} from './trusted-groups'
import { resolveModeDir, gitBranch, runHookDelete, removePlainWorktree } from './dir-resolve'
import { jsonlMtimes, captureNewSessionId, recentSessions } from './session-id'
import { recordChat, chatLabel } from './known-chats'

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
// Telegram's typing action already lives ~5s, so refreshing faster is pure waste —
// and with several topics of one supergroup all nudging every poll tick it burst-hit
// the per-CHAT sendChatAction limit (429 retry-after), dropping the indicator at random.
// ponytail: per-(chat,thread) 4s throttle — under 5s so the indicator never lapses.
const lastTyping = new Map<string, number>()
function typing(chatId: string, threadId?: number): void {
  const k = `${chatId}:${threadId ?? ''}`
  const now = Date.now()
  if (now - (lastTyping.get(k) ?? 0) < 4000) {
    return
  }
  lastTyping.set(k, now)
  void bot.api
    .sendChatAction(chatId, 'typing', threadId != null ? { message_thread_id: threadId } : {})
    .catch(err => {
      // frequent send → a good place to notice the topic was deleted out from under us
      if (threadId != null && isThreadGoneError(err)) {
        void onTopicGone(`${chatId}/${threadId}`)
      } else {
        log(`typing failed: chat=${chatId} ${err}`)
      }
    })
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
// Optional: incoming voice messages get auto-transcribed if set. Unset = leave voice
// messages as the raw attachment + "(voice message)" placeholder, same as before.
// Model/base URL are configurable (not hardcoded) so swapping provider or model later
// is an env change, not a code change — same names hermes already uses for the same
// purpose (STT_OPENAI_MODEL/STT_OPENAI_BASE_URL), and gpt-4o-transcribe beats whisper-1
// for Russian: punctuation, capitalization.
const STT_KEY = process.env.OPENAI_API_KEY
const STT_MODEL = process.env.STT_OPENAI_MODEL || 'gpt-4o-transcribe'
const STT_BASE_URL = process.env.STT_OPENAI_BASE_URL || 'https://api.openai.com/v1'

// Outgoing voice: reply(..., voice: true) speaks the text instead of just sending it as a
// message. Same key as STT; model/voice/base URL match what hermes already settled on.
const TTS_KEY = process.env.OPENAI_API_KEY
const TTS_MODEL = process.env.TTS_OPENAI_MODEL || 'gpt-4o-mini-tts'
const TTS_VOICE = process.env.TTS_OPENAI_VOICE || 'onyx'
const TTS_BASE_URL = process.env.TTS_OPENAI_BASE_URL || 'https://api.openai.com/v1'

// base for /bind <name>; absolute paths and ~/… still work
const PROJECTS_DIR = process.env.TELEGRAM_PROJECTS_DIR || join(homedir(), 'projects')

// Append a "⚠️ Контекст NN%" line to agent replies once context usage reaches this %.
// 0 (or invalid) disables it. Configurable via TELEGRAM_CONTEXT_WARN_PCT (default 80).
const CONTEXT_WARN_PCT = (() => {
  const n = Number(process.env.TELEGRAM_CONTEXT_WARN_PCT ?? '80')
  return Number.isFinite(n) ? n : 80
})()

// Debug log (screenlog.jsonl) writes ALL Telegram traffic to disk — a dev aid, off by default
// so the public plugin doesn't log everyone's messages. Enable with TELEGRAM_DEBUG_LOG=1.
const DEBUG_LOG = /^(1|true|yes|on)$/i.test(process.env.TELEGRAM_DEBUG_LOG ?? '')

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

// Raw Telegram traffic → debug log (see logDebugEvent below; hoisted).
// getUpdates would log the long-poll loop itself, sendChatAction is typing spam.
const TG_OUT_SKIP = new Set(['getUpdates', 'sendChatAction'])
bot.api.config.use((prev, method, payload, signal) => {
  if (!TG_OUT_SKIP.has(method)) {
    logDebugEvent({ type: 'tg_out', method, payload })
  }
  return prev(method, payload, signal)
})
bot.use(async (ctx, next) => {
  logDebugEvent({ type: 'tg_in', update: ctx.update })
  await next()
})

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
  if (!s?.cwd) {
    return []
  }
  // a legacy (no-bindingKeys) session falls back to "keys pointing at my dir", but
  // never one another live session already explicitly claims (mode: folder dir-share)
  const claimed = new Set<string>()
  for (const c of router.all()) {
    if (c !== conn) {
      for (const k of router.get(c)?.bindingKeys ?? []) {
        claimed.add(k)
      }
    }
  }
  return keysForDir(loadBindings(), s.cwd).filter(k => !claimed.has(k))
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

// reply targets a specific topic — a session may only send into its OWN (chat,thread),
// not just any topic of a chat it happens to be bound to somewhere else. targetFor
// returns an explicit thread_id verbatim, so without this a session bound to -100/10
// could pass thread_id:20 and post into a sibling topic.
// ponytail: react/edit still assert only the chat — bounding an arbitrary message_id to
// the session's own topic needs a per-binding sent/received msg-id registry; deferred,
// the actor there is an already-shell-compromised session (weaker boundary).
function assertBoundTarget(conn: Socket<undefined>, target: Target): void {
  const ok = ownKeys(conn).some(k => {
    const t = keyToTarget(k)
    return t.chat_id === target.chat_id && t.thread_id === target.thread_id
  })
  if (!ok) {
    const where = target.thread_id != null ? `${target.chat_id}/${target.thread_id}` : target.chat_id
    throw new Error(`${where} is not bound to this session's project`)
  }
}

async function doReply(conn: Socket<undefined>, params: Record<string, unknown>): Promise<string> {
  const target = targetFor(
    ownKeys(conn),
    params.chat_id as string | undefined,
    params.thread_id as string | undefined,
  )
  assertBoundTarget(conn, target)
  let text = params.text as string
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

  // Context-usage warning on real agent replies (this path only — hub control/status
  // messages don't go through doReply). % is scraped from the session's pane status line
  // (cached by pollScreens). Only when at/above the configured threshold.
  if (CONTEXT_WARN_PCT > 0) {
    const pane = router.get(conn)?.pane
    const pct = pane ? parseContextPct(await capturePane(pane).catch(() => '')) : undefined
    if (pct != null && pct >= CONTEXT_WARN_PCT) {
      text = `${text}\n\n⚠️ Контекст: ${pct}%` // снизу — чтобы не отодвигать сам ответ вниз экрана
    }
  }

  const chunks = chunk(text, MAX_CHUNK_LIMIT, 'length')
  // thread on EVERY send — otherwise chunks/files without reply_to land in General
  const threadOpt = target.thread_id != null ? { message_thread_id: target.thread_id } : {}
  const sentIds: number[] = []
  try {
    for (let i = 0; i < chunks.length; i++) {
      const base = {
        ...threadOpt,
        ...(reply_to != null && i === 0 ? { reply_parameters: { message_id: reply_to } } : {}),
      }
      let sent
      if (parseMode) {
        // explicit format=markdownv2 — caller escaped it themselves, send raw
        sent = await bot.api.sendMessage(target.chat_id, chunks[i], { ...base, parse_mode: parseMode })
      } else {
        // default: agents write plain markdown → render it as Telegram HTML. Fall back to plain
        // text if the converted HTML is somehow rejected, so a message is never lost.
        sent = await bot.api
          .sendMessage(target.chat_id, mdToHtml(chunks[i]), { ...base, parse_mode: 'HTML' })
          .catch(() => bot.api.sendMessage(target.chat_id, chunks[i], base))
      }
      sentIds.push(sent.message_id)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (target.thread_id != null && isThreadGoneError(err)) {
      void onTopicGone(`${target.chat_id}/${target.thread_id}`) // topic deleted mid-session
    }
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
  if (params.voice === true) {
    const audio = await synthesizeSpeech(text)
    if (audio) {
      const sent = await bot.api.sendVoice(target.chat_id, new InputFile(audio, 'reply.ogg'), {
        ...threadOpt,
        ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
      })
      sentIds.push(sent.message_id)
    }
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

// Best-effort: any failure (no key, API error) just falls back to the raw
// "(voice message)" placeholder the session already knew how to handle.
// No ffmpeg step — Telegram's .oga IS an Ogg/Opus stream, byte-identical to .ogg;
// Whisper only keys off the filename extension in the upload, so a plain rename
// (no re-encode) is enough. Verified against real voice notes before landing this.
async function transcribeVoice(oggPath: string): Promise<string | undefined> {
  if (!STT_KEY) {
    return undefined
  }
  try {
    const form = new FormData()
    form.append('file', new Blob([readFileSync(oggPath)]), 'voice.ogg')
    form.append('model', STT_MODEL)
    form.append('language', 'ru')
    const res = await fetch(`${STT_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${STT_KEY}` },
      body: form,
    })
    if (!res.ok) {
      log(`STT transcription failed: HTTP ${res.status}`)
      return undefined
    }
    const data = (await res.json()) as { text: string }
    return data.text
  } catch (e) {
    log(`STT transcription error: ${e}`)
    return undefined
  }
}

// response_format 'opus' from OpenAI TTS is a real Ogg/Opus container — exactly what
// Telegram's sendVoice wants, no conversion step (verified against a real call before
// landing this, same as the STT rename trick above).
async function synthesizeSpeech(text: string): Promise<Buffer | undefined> {
  if (!TTS_KEY) {
    return undefined
  }
  try {
    const res = await fetch(`${TTS_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TTS_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'opus' }),
    })
    if (!res.ok) {
      log(`TTS synthesis failed: HTTP ${res.status}`)
      return undefined
    }
    return Buffer.from(await res.arrayBuffer())
  } catch (e) {
    log(`TTS synthesis error: ${e}`)
    return undefined
  }
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
      .sendMessage(chat_id, `🔐 <b>Запрос разрешения</b>\n\n<code>${escHtml(tool_name)}</code>`, {
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

// binding keys mid intentional teardown (e.g. /restart) — suppress the crash notice for these
const expectedDisconnect = new Set<string>()
const DEATH_GRACE_MS = 5000

// a stub's socket can close two ways: intentional (/restart flagged it in expectedDisconnect)
// or the tmux pane/process just died — the latter used to be silent until the user's next
// message revived it. Wait a beat for a reconnect (new spawn) before alarming.
async function notifyUnexpectedDeath(s: SessionInfo): Promise<void> {
  const key = s.bindingKeys?.[0]
  if (!key || expectedDisconnect.has(key)) {
    return
  }
  await new Promise(r => setTimeout(r, DEATH_GRACE_MS))
  if (expectedDisconnect.has(key)) {
    return
  }
  const binding = loadBindings()[key]
  if (!binding || connsForBinding(key, binding.dir).length > 0) {
    return
  }
  const target = keyToTarget(key)
  await bot.api
    .sendMessage(
      target.chat_id,
      '💀 <b>Сессия оборвалась неожиданно</b> (процесс/tmux пропал без <code>/restart</code>). ' +
        'Напиши что-нибудь — переподнимется автоматически, или используй <code>/resume</code>.',
      { ...(target.thread_id != null ? { message_thread_id: target.thread_id } : {}), parse_mode: 'HTML' },
    )
    .catch(() => {})
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
      const s = router.get(sock)
      router.unsubscribe(sock)
      feeders.delete(sock)
      for (const [id, p] of pendingPermissions) {
        if (p.conn === sock) {
          pendingPermissions.delete(id)
        }
      }
      log(`stub disconnected (${router.size()} left)`)
      if (s) {
        void notifyUnexpectedDeath(s)
      }
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

// allow-check scoped to ONE binding (not chat-wide) — for answering a specific topic's
// picker, where "allowed somewhere in this chat" would let a topic-A user answer topic-B.
function bindingAllowsKey(key: string, senderId: string): boolean {
  return loadBindings()[key]?.allow?.includes(senderId) ?? false
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
// The 'Exit anyway' confirm during /stop//restart is NOT here on purpose: it
// surfaces as Telegram buttons via the picker bridge so the user can see the
// background task and choose; stopSession auto-answers only after a grace period.
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
  // Reserve the slot synchronously before the await below — otherwise an overlapping
  // pollScreens tick for the same pane sees `existing === undefined` too and double-sends.
  activePickers.set(pane, {
    chatId: target.chatId,
    ...(target.threadId != null ? { threadId: target.threadId } : {}),
    msgId: -1,
    hash: picker.hash,
    token: picker.hash,
    picker,
  })
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
  } else if (activePickers.get(pane)?.msgId === -1) {
    activePickers.delete(pane) // send failed — don't leave a permanently-unresolvable placeholder
  }
}

// Subagent tracking, fed by PreToolUse/SubagentStart/SubagentStop/Stop hooks
// (src/subagent-hook.ts) — independent of the screen-diff typing nudge below, and used
// to render a self-editing "active agents" status message per binding key. Finished
// agents stay in the list (checkmark instead of the running dot) rather than
// disappearing — the message is the batch's history, not just a running snapshot.
// A batch = one turn — but Stop fires whenever the FOREGROUND response finishes, even if
// a run_in_background agent is still going, so "Stop happened" alone can't close a batch:
// a genuinely new message is only warranted once Stop has fired AND every tracked agent is
// actually done. Otherwise a still-running background agent would be silently abandoned in
// its old (now-replaced) map the moment the next turn starts a fresh one.
type SubagentStatus = { name: string; done: boolean }
const activeSubagents = new Map<string, Map<string, SubagentStatus>>() // key -> agentId -> status
const subagentMessages = new Map<string, { chatId: string; threadId?: number; msgId: number }>()
const turnEnded = new Map<string, boolean>() // has Stop fired since the batch's last start?
// PreToolUse(Agent) fires before SubagentStart and carries the human description;
// SubagentStart itself only has agent_id/agent_type — correlate the two via promptId.
const pendingDescriptions = new Map<string, string>()

function renderSubagentText(items: SubagentStatus[]): string {
  // Схлопываем одинаковые имена в одну строку со счётчиком — воркфлоу спавнит десятки
  // одноимённых сабагентов (напр. "workflow-subagent"), иначе статус превращается в стену.
  const groups = new Map<string, { done: number; total: number }>()
  for (const i of items) {
    const g = groups.get(i.name) ?? { done: 0, total: 0 }
    g.total++
    if (i.done) g.done++
    groups.set(i.name, g)
  }
  const all = [...groups].map(([name, g]) => {
    const glyph = g.done === g.total ? '✅' : '🟡'
    const suffix = g.total === 1 ? '' : g.done === g.total ? ` ×${g.total}` : ` ${g.done}/${g.total}`
    return `${glyph} ${escHtml(name)}${suffix}`
  })
  const lines = all.length > 25 ? [...all.slice(0, 25), `… +${all.length - 25}`] : all
  return ['🤖 <b>Агенты</b>', '', ...lines].join('\n')
}

async function handleSubagentEvent(msg: Extract<StubToHub, { op: 'subagent' }>): Promise<void> {
  if (msg.action === 'describe') {
    log(`subagent: describe promptId=${msg.promptId} "${msg.description}"`)
    pendingDescriptions.set(msg.promptId, msg.description)
    setTimeout(() => pendingDescriptions.delete(msg.promptId), 30_000) // safety net if never claimed
    return
  }
  if (msg.action === 'turnend') {
    log(`subagent: turnend keys=${msg.bindingKeys.join(',')}`)
    for (const key of msg.bindingKeys) {
      turnEnded.set(key, true)
    }
    return
  }
  // workflow agents carry no name in the hook (only "workflow-subagent") — their status comes
  // from the pane-scraped workflow line (handleWorkflow) with the real name, so skip them here
  // to avoid a duplicate generic "🤖 Агенты" message.
  if (msg.action === 'start' && msg.agentType === 'workflow-subagent') {
    return
  }
  for (const key of msg.bindingKeys) {
    let agents = activeSubagents.get(key)
    if (msg.action === 'start') {
      const allDone = !agents || [...agents.values()].every(a => a.done)
      const fresh = allDone && (turnEnded.get(key) ?? true)
      // turnEnded is shared across the subagent/task/skill trackers (it just means "a Stop
      // happened"), so a sibling tracker's own batch-start can leave it false here even
      // though OUR map was never actually initialized — !agents must force a fresh map
      // regardless of `fresh`, or the `agents!.set` below throws on undefined.
      if (fresh || !agents) {
        agents = new Map()
        activeSubagents.set(key, agents)
        if (fresh) {
          subagentMessages.delete(key) // previous batch is fully wrapped up — start a fresh one
        }
      }
      turnEnded.set(key, false) // at least one agent is running again — batch stays open
      const description = pendingDescriptions.get(msg.promptId)
      if (description) {
        pendingDescriptions.delete(msg.promptId)
      }
      agents.set(msg.agentId, { name: description ?? msg.agentType, done: false })
      log(`subagent: start key=${key} agentId=${msg.agentId} type=${msg.agentType} fresh=${fresh} name="${description ?? msg.agentType}"`)
    } else {
      const existing = agents?.get(msg.agentId)
      if (existing) {
        existing.done = true
      }
      log(`subagent: stop key=${key} agentId=${msg.agentId} found=${!!existing}`)
    }
    if (!agents) {
      continue // stop event with nothing tracked (e.g. hub restarted mid-batch) — nothing to say
    }
    const text = renderSubagentText([...agents.values()])
    const tracked = subagentMessages.get(key)
    if (!tracked) {
      const target = keyToTarget(key)
      // reserve the slot SYNCHRONOUSLY before the await — a workflow fans out N agents at once,
      // so N start events race here; without the reservation each sees "no message" and sends
      // its own, spamming N separate bubbles instead of one self-editing message.
      subagentMessages.set(key, { chatId: target.chat_id, ...(target.thread_id != null ? { threadId: target.thread_id } : {}), msgId: -1 })
      const sent = await bot.api
        .sendMessage(target.chat_id, text, {
          ...(target.thread_id != null ? { message_thread_id: target.thread_id } : {}),
          parse_mode: 'HTML',
        })
        .catch(() => undefined)
      if (!sent) {
        subagentMessages.delete(key) // send failed — release the reservation
        continue
      }
      subagentMessages.set(key, { chatId: target.chat_id, ...(target.thread_id != null ? { threadId: target.thread_id } : {}), msgId: sent.message_id })
      // events that raced in while we were sending skipped their edit (msgId was -1) — re-render now
      const latest = renderSubagentText([...agents.values()])
      if (latest !== text) {
        await bot.api.editMessageText(target.chat_id, sent.message_id, latest, { parse_mode: 'HTML' }).catch(() => {})
      }
      continue
    }
    if (tracked.msgId === -1) {
      continue // first send still in flight — the post-send re-render above will pick up this state
    }
    await bot.api.editMessageText(tracked.chatId, tracked.msgId, text, { parse_mode: 'HTML' }).catch(() => {})
  }
}

// Compaction progress, scraped from the pane (no hook exposes the %): Claude Code renders
// "✻ Compacting conversation… (elapsed)" + a "▰▱… NN%" bar during /compact and auto-compact.
// Mirror it into one self-editing Telegram message per pane. capturePane occasionally catches
// a mid-redraw frame WITHOUT the line, so finalize only after 2 consecutive misses (anti-flicker).
type CompactState = { chatId: string; threadId?: number; msgId: number; lastPct: number; misses: number }
const compactMessages = new Map<string, CompactState>() // key = pane

function renderCompactBar(pct: number, elapsed?: string): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)))
  const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled)
  return `🗜 <b>Компакция</b> ${bar} ${pct}%${elapsed ? ` <i>(${escHtml(elapsed)})</i>` : ''}`
}

async function handleCompaction(pane: string, session: SessionInfo, text: string): Promise<void> {
  const prog = parseCompaction(text)
  const existing = compactMessages.get(pane)
  if (prog) {
    if (!existing) {
      const target = pickerChatFor(session)
      if (!target) {
        return
      }
      // reserve the slot synchronously so an overlapping tick doesn't double-send
      compactMessages.set(pane, { chatId: target.chatId, ...(target.threadId != null ? { threadId: target.threadId } : {}), msgId: -1, lastPct: prog.pct, misses: 0 })
      const sent = await bot.api
        .sendMessage(target.chatId, renderCompactBar(prog.pct, prog.elapsed), {
          ...(target.threadId != null ? { message_thread_id: target.threadId } : {}),
          parse_mode: 'HTML',
        })
        .catch(() => undefined)
      if (sent) {
        compactMessages.set(pane, { chatId: target.chatId, ...(target.threadId != null ? { threadId: target.threadId } : {}), msgId: sent.message_id, lastPct: prog.pct, misses: 0 })
      } else if (compactMessages.get(pane)?.msgId === -1) {
        compactMessages.delete(pane)
      }
      return
    }
    existing.misses = 0
    if (existing.msgId === -1 || prog.pct === existing.lastPct) {
      return // still sending, or bar hasn't moved — skip the edit (Telegram rate-limits edits)
    }
    existing.lastPct = prog.pct
    await bot.api
      .editMessageText(existing.chatId, existing.msgId, renderCompactBar(prog.pct, prog.elapsed), { parse_mode: 'HTML' })
      .catch(() => {})
  } else if (existing && existing.msgId !== -1) {
    if (++existing.misses < 2) {
      return // tolerate a single flicker frame before declaring it done
    }
    compactMessages.delete(pane)
    await bot.api
      .editMessageText(existing.chatId, existing.msgId, '✅ <b>Компакция готова.</b>', { parse_mode: 'HTML' })
      .catch(() => {})
  }
}

// Running-workflow status, scraped from the pane — hooks expose only "workflow-subagent" with
// no name, but Claude Code renders the real name + agent count on one bottom line. Same
// self-editing + 2-miss anti-flicker as compaction; the workflow-subagent hook status is
// suppressed (handleSubagentEvent) so this doesn't double up.
type WorkflowState = { chatId: string; threadId?: number; msgId: number; last: string; name: string; total: number; misses: number }
const workflowMessages = new Map<string, WorkflowState>() // key = pane

function renderWorkflow(name: string, done: number, total: number): string {
  return `${done >= total ? '✅' : '🤖'} <b>Воркфлоу</b> <code>${escHtml(name)}</code> — ${done}/${total} агентов`
}

async function handleWorkflow(pane: string, session: SessionInfo, text: string): Promise<void> {
  const wf = parseWorkflow(text)
  const existing = workflowMessages.get(pane)
  if (wf) {
    const key = `${wf.name} ${wf.done}/${wf.total}`
    if (!existing) {
      const target = pickerChatFor(session)
      if (!target) {
        return
      }
      const base = { chatId: target.chatId, ...(target.threadId != null ? { threadId: target.threadId } : {}) }
      workflowMessages.set(pane, { ...base, msgId: -1, last: key, name: wf.name, total: wf.total, misses: 0 }) // reserve
      const sent = await bot.api
        .sendMessage(target.chatId, renderWorkflow(wf.name, wf.done, wf.total), {
          ...(target.threadId != null ? { message_thread_id: target.threadId } : {}),
          parse_mode: 'HTML',
        })
        .catch(() => undefined)
      if (sent) {
        workflowMessages.set(pane, { ...base, msgId: sent.message_id, last: key, name: wf.name, total: wf.total, misses: 0 })
      } else if (workflowMessages.get(pane)?.msgId === -1) {
        workflowMessages.delete(pane)
      }
      return
    }
    existing.misses = 0
    existing.name = wf.name
    existing.total = wf.total
    if (existing.msgId === -1 || existing.last === key) {
      return // still sending, or count unchanged — skip the edit
    }
    existing.last = key
    await bot.api
      .editMessageText(existing.chatId, existing.msgId, renderWorkflow(wf.name, wf.done, wf.total), { parse_mode: 'HTML' })
      .catch(() => {})
  } else if (existing && existing.msgId !== -1) {
    if (++existing.misses < 2) {
      return // tolerate a flicker frame before declaring it done
    }
    workflowMessages.delete(pane)
    await bot.api
      .editMessageText(existing.chatId, existing.msgId, `✅ <b>Воркфлоу</b> <code>${escHtml(existing.name)}</code> готов (${existing.total} агентов)`, { parse_mode: 'HTML' })
      .catch(() => {})
  }
}

// Push error/auth banners (API Error, expired login, …) into the bound topic — no hook
// fires for them, so without this the user only sees them if watching tmux. Edge-triggered
// and deduped: the pane is scraped every 1.5s and a banner lingers for many ticks, so we
// notify once per NEW banner and re-arm after it scrolls off (parseError → undefined).
// ponytail: immediate re-arm can double-notify if a banner flickers in/out of the scanned
// window; errors are rare and missing one is worse than a rare dup — add a miss-counter if it nags.
const lastError = new Map<string, string>() // key = pane → last-notified banner

async function handleErrors(pane: string, session: SessionInfo, text: string): Promise<void> {
  const err = parseError(text)
  if (!err) {
    lastError.delete(pane)
    return
  }
  if (lastError.get(pane) === err) {
    return
  }
  lastError.set(pane, err)
  const target = pickerChatFor(session)
  if (!target) {
    return
  }
  await bot.api
    .sendMessage(target.chatId, `⛔️ <b>Ошибка в сессии</b>\n\n<code>${escHtml(err)}</code>`, {
      ...(target.threadId != null ? { message_thread_id: target.threadId } : {}),
      parse_mode: 'HTML',
    })
    .catch(e => log(`error-notify failed: pane=${pane} ${e}`))
}

// Task-list tracking, fed by TaskCreate/TaskUpdate hooks — same self-editing-message and
// same turn-boundary idea as subagents above (reuses turnEnded), but no promptId dance:
// id/subject/status come straight off one PostToolUse event each.
type TaskStatus = { subject: string; status: string }
const activeTasks = new Map<string, Map<string, TaskStatus>>() // key -> taskId -> status
const taskMessages = new Map<string, { chatId: string; threadId?: number; msgId: number }>()

function renderTaskText(items: TaskStatus[]): string {
  const glyph = (s: string) => (s === 'completed' ? '✅' : s === 'in_progress' ? '🟡' : '⏳')
  const lines = items.map(i => `${glyph(i.status)} ${escHtml(i.subject)}`)
  return ['📋 <b>Задачи</b>', '', ...lines].join('\n')
}

async function handleTaskEvent(msg: Extract<StubToHub, { op: 'task' }>): Promise<void> {
  for (const key of msg.bindingKeys) {
    let tasks = activeTasks.get(key)
    if (msg.action === 'create') {
      const allDone = !tasks || [...tasks.values()].every(t => t.status === 'completed')
      const fresh = allDone && (turnEnded.get(key) ?? true)
      // see the identical comment in handleSubagentEvent — turnEnded is shared across
      // trackers, so !tasks must force init regardless of `fresh`.
      if (fresh || !tasks) {
        tasks = new Map()
        activeTasks.set(key, tasks)
        if (fresh) {
          taskMessages.delete(key)
        }
      }
      turnEnded.set(key, false)
      tasks.set(msg.taskId, { subject: msg.subject, status: 'pending' })
      log(`task: create key=${key} taskId=${msg.taskId} fresh=${fresh} subject="${msg.subject}"`)
    } else {
      const existing = tasks?.get(msg.taskId)
      if (existing) {
        existing.status = msg.status
      }
      log(`task: update key=${key} taskId=${msg.taskId} status=${msg.status} found=${!!existing}`)
    }
    if (!tasks) {
      continue
    }
    const text = renderTaskText([...tasks.values()])
    const tracked = taskMessages.get(key)
    if (!tracked) {
      const target = keyToTarget(key)
      const sent = await bot.api
        .sendMessage(target.chat_id, text, {
          ...(target.thread_id != null ? { message_thread_id: target.thread_id } : {}),
          parse_mode: 'HTML',
        })
        .catch(() => undefined)
      if (sent) {
        taskMessages.set(key, { chatId: target.chat_id, ...(target.thread_id != null ? { threadId: target.thread_id } : {}), msgId: sent.message_id })
      }
      continue
    }
    await bot.api.editMessageText(tracked.chatId, tracked.msgId, text, { parse_mode: 'HTML' }).catch(() => {})
  }
}

// TodoWrite (the ⊡/✓ checklist tool) — carries the FULL list each call, so no per-item lifecycle:
// just re-render one self-editing message per turn. Fresh message on a turn boundary (reuses
// turnEnded), like tasks. Reservation guard (msgId=-1) against a rare back-to-back double-send.
type Todo = { content: string; status: string }
const todoMessages = new Map<string, { chatId: string; threadId?: number; msgId: number }>()

function renderTodoText(todos: Todo[]): string {
  const glyph = (s: string) => (s === 'completed' ? '✅' : s === 'in_progress' ? '🟡' : '⏳')
  const lines = todos.map(t => `${glyph(t.status)} ${escHtml(t.content)}`)
  return ['📝 <b>Тудушки</b>', '', ...lines].join('\n')
}

async function handleTodoEvent(msg: Extract<StubToHub, { op: 'todo' }>): Promise<void> {
  for (const key of msg.bindingKeys) {
    if (turnEnded.get(key) ?? true) {
      todoMessages.delete(key) // new turn — start a fresh message at the bottom
    }
    turnEnded.set(key, false)
    const text = renderTodoText(msg.todos)
    const tracked = todoMessages.get(key)
    if (!tracked) {
      const target = keyToTarget(key)
      todoMessages.set(key, { chatId: target.chat_id, ...(target.thread_id != null ? { threadId: target.thread_id } : {}), msgId: -1 }) // reserve
      const sent = await bot.api
        .sendMessage(target.chat_id, text, { ...(target.thread_id != null ? { message_thread_id: target.thread_id } : {}), parse_mode: 'HTML' })
        .catch(() => undefined)
      if (sent) {
        todoMessages.set(key, { chatId: target.chat_id, ...(target.thread_id != null ? { threadId: target.thread_id } : {}), msgId: sent.message_id })
      } else if (todoMessages.get(key)?.msgId === -1) {
        todoMessages.delete(key)
      }
      continue
    }
    if (tracked.msgId === -1) {
      continue // first send in flight
    }
    await bot.api.editMessageText(tracked.chatId, tracked.msgId, text, { parse_mode: 'HTML' }).catch(() => {})
  }
}

// Skill invocations — same per-turn self-editing message as tasks, но append-only:
// у Skill нет жизненного цикла, одно PreToolUse-событие на вызов.
type SkillCall = { skill: string; args?: string }
const activeSkills = new Map<string, SkillCall[]>() // key -> calls this turn
const skillMessages = new Map<string, { chatId: string; msgId: number }>()

function renderSkillText(items: SkillCall[]): string {
  return items.map(i => `🧩 Скилл: <b>${escHtml(i.skill)}</b>${i.args ? ` — <i>${escHtml(i.args)}</i>` : ''}`).join('\n')
}

async function handleSkillEvent(msg: Extract<StubToHub, { op: 'skill' }>): Promise<void> {
  for (const key of msg.bindingKeys) {
    let skills = activeSkills.get(key)
    if (!skills || (turnEnded.get(key) ?? true)) {
      skills = []
      activeSkills.set(key, skills)
      skillMessages.delete(key)
    }
    turnEnded.set(key, false)
    skills.push({ skill: msg.skill, ...(msg.args ? { args: msg.args } : {}) })
    log(`skill: key=${key} skill=${msg.skill}${msg.args ? ` args="${msg.args}"` : ''}`)
    const text = renderSkillText(skills)
    const tracked = skillMessages.get(key)
    if (!tracked) {
      const target = keyToTarget(key)
      const sent = await bot.api
        .sendMessage(target.chat_id, text, {
          ...(target.thread_id != null ? { message_thread_id: target.thread_id } : {}),
          parse_mode: 'HTML',
        })
        .catch(() => undefined)
      if (sent) {
        skillMessages.set(key, { chatId: target.chat_id, msgId: sent.message_id })
      }
      continue
    }
    await bot.api.editMessageText(tracked.chatId, tracked.msgId, text, { parse_mode: 'HTML' }).catch(() => {})
  }
}

// One capture per live pane per tick, fanned out to screen detectors.
// last captured frame per pane — a change since the previous poll means the
// agent (or something) is actively doing something, worth a "typing…" nudge
const lastPaneText = new Map<string, string>()

let pollingScreens = false
async function pollScreens(): Promise<void> {
  if (pollingScreens) {
    return // previous tick still running (many bound sessions can outrun SCREEN_POLL_MS) — skip, don't overlap
  }
  pollingScreens = true
  try {
    await pollScreensOnce()
  } finally {
    pollingScreens = false
  }
}

async function pollScreensOnce(): Promise<void> {
  const seen = new Set<string>()
  for (const conn of router.all()) {
    const s = router.get(conn)
    if (!s?.pane || !s.cwd) {
      continue
    }
    seen.add(s.pane)
    const text = await capturePane(s.pane).catch(() => '')
    await detectPicker(s.pane, s, text)
    await handleCompaction(s.pane, s, text)
    await handleWorkflow(s.pane, s, text)
    await handleErrors(s.pane, s, text)
    const prev = lastPaneText.get(s.pane)
    // subagents running = definitely busy, even on ticks where the visible screen
    // (e.g. just an elapsed-time counter) happens to render identically to the last poll
    const busy = s.bindingKeys?.some(k => [...(activeSubagents.get(k)?.values() ?? [])].some(a => !a.done)) ?? false
    if (busy || (prev !== undefined && prev !== text)) {
      const target = pickerChatFor(s)
      if (target) {
        typing(target.chatId, target.threadId)
      }
    }
    lastPaneText.set(s.pane, text)
  }
  for (const pane of [...activePickers.keys()]) {
    if (!seen.has(pane)) {
      activePickers.delete(pane)
    }
  }
  for (const pane of [...lastPaneText.keys()]) {
    if (!seen.has(pane)) {
      lastPaneText.delete(pane)
    }
  }
  for (const pane of [...compactMessages.keys()]) {
    if (!seen.has(pane)) {
      compactMessages.delete(pane) // session gone — drop the in-flight progress message
    }
  }
  for (const pane of [...lastError.keys()]) {
    if (!seen.has(pane)) {
      lastError.delete(pane)
    }
  }
  for (const pane of [...workflowMessages.keys()]) {
    if (!seen.has(pane)) {
      workflowMessages.delete(pane)
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
  void capturePane(pane)
    .then(s => logDebugEvent({
      type: 'screen', key: ap.chatId, pane,
      trigger: `pick:${action.kind}${action.kind === 'opt' ? action.index : ''}`, screen: s,
    }))
    .catch(() => {})
  const labelOf = (i: number) => ap.picker.options.find(o => o.index === i)?.label ?? String(i)
  if (action.kind === 'opt' && ap.picker.mode === 'single') {
    await selectOption(pane, action.index)
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
    await selectOption(pane, 1) // Submit answers
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

// The socket is 0600, but every Claude session runs shell as the hub user, so a
// prompt-injected session could connect and claim ANOTHER binding's keys to hijack its
// traffic. A claimed key is only honoured if it exists AND its dir is the session's real
// cwd (sessions launch via `tmux -c <binding.dir>`, so this holds for legit ones).
// ponytail: dir-match can't separate two bindings that share a folder (mode: folder) —
// a random per-session capability token would; add if same-dir hijack matters.
function verifyClaimedKeys(session: SessionInfo): SessionInfo {
  if (!session.bindingKeys?.length) {
    return session
  }
  const reg = loadBindings()
  const canon = (p: string) => { try { return realpathSync(p) } catch { return p } }
  const cwd = session.cwd
  const sameDir = (a: string, b: string) => a === b || canon(a) === canon(b)
  const valid = session.bindingKeys.filter(k => cwd != null && reg[k] != null && sameDir(reg[k].dir, cwd))
  if (valid.length !== session.bindingKeys.length) {
    const dropped = session.bindingKeys.filter(k => !valid.includes(k))
    log(`subscribe: dropped unverified keys [${dropped}] for cwd=${cwd ?? '-'}`)
  }
  return { ...session, bindingKeys: valid.length ? valid : undefined }
}

async function handleStubMessage(sock: Socket<undefined>, msg: StubToHub): Promise<void> {
  if (msg.op === 'subscribe') {
    const session = verifyClaimedKeys(msg.session)
    router.subscribe(sock, session)
    learnCmdline(session)
    log(`subscribe: cwd=${session.cwd ?? '-'} pane=${session.pane ?? '-'}`)
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
    return
  }
  if (msg.op === 'subagent') {
    await handleSubagentEvent(msg)
    return
  }
  if (msg.op === 'task') {
    await handleTaskEvent(msg)
  }
  if (msg.op === 'skill') {
    await handleSkillEvent(msg)
  }
  if (msg.op === 'todo') {
    await handleTodoEvent(msg)
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
    if (!reg[k]) {
      continue // stale bindingKeys — the binding was removed after this session launched
    }
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
  if (byKey.length > 0) {
    return byKey
  }
  // dir-fallback is only for sessions that predate bindingKeys entirely — a session
  // that already reports its own bindingKeys must never be pulled in via someone
  // else's dir match (mode: folder can legitimately put two bindings on one dir).
  return router.byDir(dir).filter(conn => !router.get(conn)?.bindingKeys?.length)
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

// /screen → PNG: capture-pane -e → свой ANSI→HTML → headless chrome --screenshot.
const CHROME_BIN = Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser')

async function renderScreenPng(pane: string): Promise<Uint8Array | undefined> {
  if (!CHROME_BIN) {
    return undefined
  }
  const ansi = (await capturePaneAnsi(pane)).replace(/\s+$/, '')
  if (!ansi) {
    return undefined
  }
  const lines = ansi.split('\n')
  const cols = Math.max(...lines.map(l => l.replace(/\x1b\[[^m]*m/g, '').length), 80)
  const width = Math.min(24 + Math.ceil(cols * 8.5), 2400)
  const height = 24 + 19 * (lines.length + 1)
  const base = join(STATE_DIR, `screen-${pane.replace(/\W/g, '')}-${Date.now()}`)
  writeFileSync(`${base}.html`, ansiToHtml(ansi))
  try {
    const proc = Bun.spawn(
      [CHROME_BIN, '--headless=new', '--disable-gpu', '--hide-scrollbars',
        `--window-size=${width},${height}`, `--screenshot=${base}.png`, `file://${base}.html`],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    const done = await Promise.race([proc.exited, new Promise<undefined>(r => setTimeout(() => r(undefined), 15_000))])
    if (done === undefined) {
      proc.kill()
      return undefined
    }
    return readFileSync(`${base}.png`)
  } finally {
    rmQuiet(`${base}.html`)
    rmQuiet(`${base}.png`)
  }
}

// /screen live view: one self-updating photo message + a Close button that fully deletes it —
// /screen is a debug aid that otherwise litters the history. renderScreenPng spawns headless
// chrome (~1-2s), so refresh only when the pane text actually changed (cheap capturePane
// compare); auto-stop refreshing after SCREEN_LIVE_MS so an abandoned view doesn't render forever
// (the message + Close button stay so it can still be dismissed).
type LiveScreen = { chatId: string; threadId?: number; msgId: number; pane: string; lastText: string; timer?: ReturnType<typeof setInterval> }
const liveScreens = new Map<string, LiveScreen>() // token -> view
let screenSeq = 0
const SCREEN_REFRESH_MS = 3000
const SCREEN_LIVE_MS = 3 * 60_000

const closeKb = (token: string) => new InlineKeyboard().text('✖️ Закрыть', `scrclose:${token}`)
// live timestamp in the caption — so it's visibly "alive" even when the pane content is static
const screenCap = (pane: string, note?: string) =>
  `🖥 <code>${escHtml(pane)}</code> · ${note ?? new Date().toLocaleTimeString('ru-RU')}`

function closeLiveScreen(token: string): LiveScreen | undefined {
  const v = liveScreens.get(token)
  if (v) {
    if (v.timer) clearInterval(v.timer)
    liveScreens.delete(token)
  }
  return v
}

// auto-stop refreshing but KEEP the entry + message + Close button (so it can still be dismissed)
function stopRefreshing(token: string): void {
  const v = liveScreens.get(token)
  if (!v?.timer) {
    return
  }
  clearInterval(v.timer)
  v.timer = undefined
  void bot.api
    .editMessageCaption(v.chatId, v.msgId, { caption: screenCap(v.pane, 'обновление остановлено'), parse_mode: 'HTML', reply_markup: closeKb(token) })
    .catch(() => {})
}

async function refreshLiveScreen(token: string): Promise<void> {
  const v = liveScreens.get(token)
  if (!v) {
    return
  }
  const text = await capturePane(v.pane).catch(() => '')
  if (text === v.lastText) {
    // pane unchanged — just tick the caption (cheap, no chrome), so it's visibly live
    await bot.api
      .editMessageCaption(v.chatId, v.msgId, { caption: screenCap(v.pane), parse_mode: 'HTML', reply_markup: closeKb(token) })
      .catch(() => {})
    return
  }
  v.lastText = text
  const png = await renderScreenPng(v.pane).catch(() => undefined)
  if (!png) {
    return
  }
  // editMessageMedia drops the inline keyboard unless it's re-sent — keep the Close button
  await bot.api
    .editMessageMedia(
      v.chatId,
      v.msgId,
      { type: 'photo', media: new InputFile(png, 'screen.png'), caption: screenCap(v.pane), parse_mode: 'HTML' },
      { reply_markup: closeKb(token) },
    )
    .catch(() => {})
}

async function startLiveScreen(chatId: string, threadId: number | undefined, pane: string): Promise<void> {
  const token = String(++screenSeq)
  const kb = closeKb(token)
  const threadOpt = threadId != null ? { message_thread_id: threadId } : {}
  const png = await renderScreenPng(pane).catch(() => undefined)
  if (png) {
    const sent = await bot.api
      .sendPhoto(chatId, new InputFile(png, 'screen.png'), { ...threadOpt, caption: screenCap(pane), parse_mode: 'HTML', reply_markup: kb })
      .catch(() => undefined)
    if (sent) {
      const lastText = await capturePane(pane).catch(() => '')
      const timer = setInterval(() => void refreshLiveScreen(token), SCREEN_REFRESH_MS)
      liveScreens.set(token, { chatId, ...(threadId != null ? { threadId } : {}), msgId: sent.message_id, pane, lastText, timer })
      setTimeout(() => stopRefreshing(token), SCREEN_LIVE_MS) // stop refreshing; Close still works
      return
    }
  }
  // no chrome / photo failed → static text screen (still with a Close button)
  const text = await capturePane(pane).catch(() => '')
  const tail = text.length > 3600 ? text.slice(-3600) : text
  const sent = await bot.api
    .sendMessage(chatId, `🖥 <code>${escHtml(pane)}</code>\n<pre>${escHtml(tail)}</pre>`, { ...threadOpt, parse_mode: 'HTML', reply_markup: kb })
    .catch(() => undefined)
  if (sent) {
    liveScreens.set(token, { chatId, ...(threadId != null ? { threadId } : {}), msgId: sent.message_id, pane, lastText: tail })
  }
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
    say(`🚀 <b>${mode === 'resume' ? 'Возобновляю' : 'Запускаю заново'}</b>\n\n<code>${escHtml(launch)}</code>`)
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

// On hub start, bring back sessions whose tmux is gone (host reboot: the whole tmux server
// died with it). A plain hub restart leaves tmux alive — hasTmuxSession skips those, their
// stubs reconnect on their own. Staggered so a reboot doesn't launch every Claude at once.
let revivedOnce = false
async function reviveBoundSessions(): Promise<void> {
  if (revivedOnce) {
    return // onStart also fires on polling reconnects — revive is a boot-only pass
  }
  revivedOnce = true
  for (const [key, binding] of Object.entries(loadBindings())) {
    if (await hasTmuxSession(sessionName(key, binding.dir))) {
      continue
    }
    log(`boot-revive: ${key} → ${binding.dir}`)
    const t = keyToTarget(key)
    const say = (html: string) =>
      void bot.api
        .sendMessage(t.chat_id, html, { ...(t.thread_id != null ? { message_thread_id: t.thread_id } : {}), parse_mode: 'HTML' })
        .catch(() => {})
    await spawnSession(key, binding, binding.sessionId ? 'resume' : 'new', say)
    await new Promise(r => setTimeout(r, 3000))
  }
}

// Tear down a binding fully: remove it, kill its tmux, clean its worktree (hook if this
// binding was hook-created, else a plain `git worktree remove` when the dir is a linked
// worktree). Shared by /unbind and topic-deletion cleanup. Returns an HTML summary.
async function teardownBinding(key: string, binding: BindingEntry): Promise<string> {
  const reg = loadBindings()
  delete reg[key]
  saveBindings(reg)
  let note = `🔓 <b>Отвязано</b> <i>(было ${codePath(binding.dir)})</i>`
  // The hub created this tmux session (spawnSession) — it owns tearing it down, any mode.
  const name = sessionName(key, binding.dir)
  if (await hasTmuxSession(name)) {
    await killTmuxSession(name)
    note += `\n🪟 tmux <code>${escHtml(name)}</code> закрыт.`
  }
  const groupCfg = loadTrustedGroups()[keyToTarget(key).chat_id]
  if (binding.hookBranch && groupCfg?.hook?.delete && groupCfg.dir) {
    try {
      await runHookDelete(groupCfg.hook, binding.hookBranch, groupCfg.dir)
      note += `\n🗑 Хук очистки (<code>${escHtml(binding.hookBranch)}</code>) выполнен.`
    } catch (e) {
      note += `\n⚠️ Хук очистки не удался: ${escHtml(String(e))}`
    }
  } else {
    try {
      if (await removePlainWorktree(binding.dir)) {
        note += `\n🗑 Worktree удалён (<code>git worktree remove</code>).`
      }
    } catch (e) {
      note += `\n⚠️ Удаление worktree не удалось: ${escHtml(String(e))}`
    }
  }
  return note
}

// Telegram has NO "forum topic deleted" update (unlike created/closed/reopened) — bots
// aren't told. So a deleted topic is detected reactively: the next send to it fails with
// "message thread not found". That error triggers this teardown; notifications go to
// General (no thread_id), since the topic itself is gone.
function isThreadGoneError(err: unknown): boolean {
  const d = err instanceof GrammyError ? err.description : String((err as { message?: string })?.message ?? err)
  return /message thread not found|thread not found|TOPIC_DELETED/i.test(d)
}
const tearingDown = new Set<string>()
async function onTopicGone(key: string): Promise<void> {
  if (tearingDown.has(key) || !loadBindings()[key]) {
    return
  }
  tearingDown.add(key)
  try {
    const binding = loadBindings()[key]
    if (!binding) {
      return
    }
    log(`topic gone: ${key} — auto-unbind + cleanup`)
    const note = await teardownBinding(key, binding)
    void bot.api
      .sendMessage(keyToTarget(key).chat_id, `🗑 <b>Топик удалён</b> — прибрал за ним.\n\n${note}`, { parse_mode: 'HTML' })
      .catch(() => {})
  } finally {
    tearingDown.delete(key)
  }
}

// new forum topic in a trusted group → auto-bind + auto-start, no /bind needed
type PendingTopic = { cfg: TrustedGroupConfig; mode: TrustedGroupMode; topicName: string; say: (html: string) => void }
const pendingTopics = new Map<string, PendingTopic>() // waiting for a "which folder?" answer
// mode picker sent, waiting for a button tap — before dir resolution starts
type PendingModeChoice = { cfg: TrustedGroupConfig; topicName: string; say: (html: string) => void }
const pendingModeChoice = new Map<string, PendingModeChoice>()

// Messages typed while a topic is still being set up (mode not yet picked, session not yet
// up). Held here and delivered by flushQueued once the session connects, so the first task
// isn't lost. Keyed by binding key.
const queuedMessages = new Map<string, Inbound[]>()
function enqueueForTopic(key: string, inbound: Inbound): void {
  const q = queuedMessages.get(key) ?? []
  q.push(inbound)
  queuedMessages.set(key, q)
  const msgId = inbound.ctx.message?.message_id
  if (msgId != null) {
    // 👌 = "held, will deliver once the session is up" (⏳ isn't in Telegram's reaction set)
    void bot.api.setMessageReaction(String(inbound.ctx.chat!.id), msgId, [{ type: 'emoji', emoji: '👌' }]).catch(() => {})
  }
}
async function flushQueued(key: string): Promise<void> {
  const q = queuedMessages.get(key)
  queuedMessages.delete(key)
  if (!q?.length) {
    return
  }
  const conns = await waitForBinding(key, 30_000)
  if (!conns.length) {
    const c = q[0]?.ctx
    if (c?.chat) {
      const tid = c.message?.message_thread_id
      void bot.api
        .sendMessage(String(c.chat.id), '⚠️ Сессия не поднялась вовремя — отложенные сообщения не доставлены, повтори.', {
          ...(tid != null ? { message_thread_id: tid } : {}),
          parse_mode: 'HTML',
        })
        .catch(() => {})
    }
    return
  }
  for (const inb of q) {
    await handleInbound(inb) // binding now exists → normal delivery path
  }
}

// mode is known — start the session. Branch/slug is always the topic name (no "type a
// branch" window: it only ate the user's first message). Dir from group config, or ask.
function beginTopicSession(
  key: string,
  cfg: TrustedGroupConfig,
  mode: TrustedGroupMode,
  topicName: string,
  say: (html: string) => void,
): void {
  if (!cfg.dir) {
    say('📁 Пришли папку для этого топика — как в <code>/bind</code>: имя в ~/projects или абсолютный путь.')
    pendingTopics.set(key, { cfg, mode, topicName, say })
    return
  }
  void runAutoTopic(key, cfg, cfg.dir, mode, slugFromTopicName(topicName), say)
}

async function runAutoTopic(
  key: string,
  cfg: TrustedGroupConfig,
  dir: string,
  mode: TrustedGroupMode,
  branch: string,
  say: (html: string) => void,
): Promise<void> {
  const branchNote = mode === 'folder' ? '' : `, ветка <code>${escHtml(branch)}</code>`
  say(`⏳ Готовлю сессию (<code>${escHtml(mode)}</code>${branchNote})…`)
  try {
    const resolvedDir = await resolveModeDir(mode, dir, cfg.hook, branch)
    const reg = loadBindings()
    reg[key] = {
      dir: resolvedDir,
      ...(cfg.cmdline ? { cmdline: cfg.cmdline } : {}),
      ...(mode === 'worktree' && cfg.hook ? { hookBranch: branch } : {}),
    }
    saveBindings(reg)
    await spawnSession(key, reg[key], 'new', say)
  } catch (e) {
    say(`⚠️ <b>Не удалось поднять сессию</b>: ${escHtml(String(e))}`)
  } finally {
    // always drain the hold queue — deliver on success, or tell the user + clear it on failure
    await flushQueued(key)
  }
}

const OWN_DIR_LABEL = '✏️ Своя папка'

function modeKeyboard(key: string, cfg: TrustedGroupConfig): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const m of cfg.modes) {
    kb.text(MODE_LABEL[m], `topicmode:${key}:${m}`).row()
  }
  return kb.text(OWN_DIR_LABEL, `topicdir:${key}`).row()
}

const MODE_EXPLAIN: Record<TrustedGroupMode, string> = {
  folder: '📁 <b>Папка по умолчанию</b> — работать прямо в базе.',
  worktree: '🌿 <b>Worktree</b> — своя git-ветка/папка от базы (обычный <code>git worktree add</code>, ' +
    'или внешний скрипт из конфига группы, если задан — напр. ещё поднимает БД).',
}

// button labels alone can't fit a path — spell out what each mode actually does here
function modePromptText(cfg: TrustedGroupConfig, intro: string): string {
  const base = cfg.dir
    ? `База: ${codePath(cfg.dir)}`
    : 'База не задана — после выбора спрошу папку.'
  const modeLines = cfg.modes.map(m => MODE_EXPLAIN[m])
  return [intro, '', base, '', ...modeLines, `${OWN_DIR_LABEL} — указать путь для этого топика вручную.`].join('\n')
}

// forum_topic_created can be missed (hub down, race) — a message in an unbound topic of a
// trusted group sets the topic up the same way. The real title isn't in a message update,
// so callers pass a generic slug (topic-<id>) as topicName; the triggering message is
// queued by the caller and delivered once the session is up.
async function handleLateTopic(
  key: string,
  chatId: string,
  threadId: number,
  cfg: TrustedGroupConfig,
  topicName: string,
  say: (html: string) => void,
): Promise<void> {
  if (cfg.modes.length > 1) {
    pendingModeChoice.set(key, { cfg, topicName, say })
    void bot.api
      .sendMessage(chatId, modePromptText(cfg, 'Похоже, это новый топик — как поднять сессию?'), {
        message_thread_id: threadId,
        parse_mode: 'HTML',
        reply_markup: modeKeyboard(key, cfg),
      })
      .catch(() => {})
    return
  }
  beginTopicSession(key, cfg, cfg.modes[0], topicName, say)
}

type Inbound = {
  ctx: Context
  text: string
  downloadImage?: () => Promise<string | undefined>
  attachment?: AttachmentMeta
}

async function handleInbound(inbound: Inbound): Promise<void> {
  const { ctx, text, downloadImage, attachment } = inbound
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
  recordChat(chat_id, chat.type, chatLabel(chat), new Date().toISOString())
  const say = (html: string) =>
    void bot.api
      .sendMessage(chat_id, html, { ...(threadId != null ? { message_thread_id: threadId } : {}), parse_mode: 'HTML' })
      .catch(() => {})

  // explicit commands always win — never swallowed by an auto-topic prompt waiting for text
  const ops = parseOpsCommand(text)
  if (ops && (!ops.bot || ops.bot.toLowerCase() === botUsername.toLowerCase())) {
    pendingTopics.delete(key)
    pendingModeChoice.delete(key)
    await handleOps({ cmd: ops.cmd, arg: ops.arg, key, chat_id, threadId, senderId, ...(msgId != null ? { msgId } : {}) })
    return
  }

  // this topic asked "which folder?" and is waiting for the answer. The dir picks the
  // session cwd (→ Claude runs there with bypassPermissions), so only an admin may supply
  // it — a non-admin group member must not be able to point a session at an arbitrary dir.
  const pendingTopic = pendingTopics.get(key)
  if (pendingTopic) {
    if (!isAdmin(senderId)) {
      log(`drop (not admin) pending-topic answer: key=${key} from=${senderId}`)
      return
    }
    let dir: string
    try {
      dir = resolveProjectDir(text.trim(), PROJECTS_DIR)
    } catch (e) {
      pendingTopic.say(`⚠️ <b>Не похоже на папку</b>: ${escHtml(e instanceof Error ? e.message : String(e))}\n\nПришли ещё раз.`)
      return
    }
    pendingTopics.delete(key)
    await runAutoTopic(key, pendingTopic.cfg, dir, pendingTopic.mode, slugFromTopicName(pendingTopic.topicName), pendingTopic.say)
    return
  }

  // custom-answer text for a picker: THIS topic's pane is waiting for free text. Match
  // the exact (chat,thread) and check allow for this specific binding — otherwise a user
  // allowed in topic A could answer topic B's AskUserQuestion (and with several pickers
  // pending, the first in Map order would be picked).
  for (const [pane, aw] of awaitingCustom) {
    if (aw.chatId !== chat_id || aw.threadId !== threadId) {
      continue
    }
    if (Date.now() - aw.at > CUSTOM_TIMEOUT_MS) {
      awaitingCustom.delete(pane)
      continue
    }
    if (isAdmin(senderId) || bindingAllowsKey(key, senderId)) {
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

  // mode picker sent, waiting for a button tap — hold this message and deliver it once the
  // session is up (flushQueued), so the first task typed before tapping isn't lost.
  if (pendingModeChoice.has(key)) {
    enqueueForTopic(key, inbound)
    return
  }

  const binding = loadBindings()[key]
  if (!binding) {
    if (threadId != null && isAdmin(senderId)) {
      const trustedCfg = loadTrustedGroups()[chat_id]
      if (trustedCfg && !trustedCfg.exclude?.topicIds?.includes(threadId)) {
        // forum_topic_created was missed (hub was down / raced) — set the topic up now,
        // triggered by this message. Queue the message so it reaches the session once it's
        // up instead of being consumed. Topic name is unknown here → generic slug.
        log(`late-binding: forum_topic_created missed for key=${key}, using message as trigger`)
        enqueueForTopic(key, inbound)
        await handleLateTopic(key, chat_id, threadId, trustedCfg, `topic-${threadId}`, say)
        return
      }
    }
    log(`drop (unbound): key=${key} from=${senderId} text=${text.slice(0, 60)}`)
    return
  }
  if (!isAdmin(senderId) && !binding.allow?.includes(senderId)) {
    log(`drop (not allowed): key=${key} from=${senderId}`)
    return
  }
  let conns = connsForBinding(key, binding.dir)
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
  snapshotScreens(key, text, conns)
  for (const conn of conns) {
    send(conn, { op: 'event', kind: 'message', content: text, meta })
  }
}

// ── debug log: pane snapshots + raw Telegram traffic, one correlated JSONL ──
// Debugging "session hung, can't reach it": what was rendered in the pane and
// what flowed through Telegram (in and out) around it, in one timeline.
// Entry types: screen | tg_in | tg_out. Last N entries kept.
// ponytail: full-file rewrite per event (~1000 entries ≈ a few MB); switch to
// append+logrotate if it ever shows up in profiles.
const SCREENLOG = join(STATE_DIR, 'screenlog.jsonl')
const SCREENLOG_MAX = 1000

function logDebugEvent(e: Record<string, unknown>): void {
  if (!DEBUG_LOG) {
    return // opt-in via TELEGRAM_DEBUG_LOG=1; off by default for the public plugin
  }
  let entry: string
  try {
    entry = JSON.stringify({ ts: new Date().toISOString(), ...e })
  } catch (err) {
    // grammY's InputFile throws on JSON.stringify by design (media payloads);
    // log the event shape without the unserializable body — never break the send.
    entry = JSON.stringify({
      ts: new Date().toISOString(), type: e.type, method: e.method,
      error: `unserializable payload: ${err}`,
    })
  }
  let lines: string[] = []
  try {
    lines = readFileSync(SCREENLOG, 'utf8').split('\n').filter(Boolean)
  } catch {}
  lines.push(entry)
  try {
    writeFileSync(SCREENLOG, lines.slice(-SCREENLOG_MAX).join('\n') + '\n')
  } catch (e) {
    log(`screenlog write failed: ${e}`)
  }
}

function snapshotScreens(key: string, trigger: string, conns: Socket[]): void {
  void (async () => {
    for (const conn of conns) {
      const pane = router.get(conn)?.pane
      if (!pane) {
        continue
      }
      const screen = await capturePane(pane).catch(e => `<capture failed: ${e}>`)
      logDebugEvent({ type: 'screen', key, pane, trigger: trigger.slice(0, 120), screen })
    }
  })()
}

// bind/unbind/allow — admins only; everything else — admins and the binding's allow users
type OpsRequest = {
  cmd: OpsCommand
  arg?: string
  key: string
  chat_id: string
  threadId?: number
  senderId: string
  msgId?: number // the user's command message — /screen deletes it to keep history clean
}

async function handleOps({ cmd, arg, key, chat_id, threadId, senderId, msgId }: OpsRequest): Promise<void> {
  const threadOpt = threadId != null ? { message_thread_id: threadId } : {}
  const say = (html: string) =>
    bot.api.sendMessage(chat_id, html, { ...threadOpt, parse_mode: 'HTML' }).catch(() => {})
  const reg = loadBindings()
  const binding: BindingEntry | undefined = reg[key]

  if (cmd === 'bind' || cmd === 'unbind' || cmd === 'allow' || cmd === 'delete') {
    if (!isAdmin(senderId)) {
      return
    }
    // /delete = teardown (unbind + tmux + worktree) AND remove the topic itself, in one go.
    // Telegram gives no topic-deleted event, so this is the clean way to delete + clean up
    // together. Reports to General, since the topic is gone by then.
    if (cmd === 'delete') {
      if (threadId == null) {
        void say('❌ <code>/delete</code> — только в топике форума (General/обычную группу так не удалить).')
        return
      }
      const note = binding ? await teardownBinding(key, binding) : '🔓 <i>Бинда тут не было.</i>'
      let delNote: string
      try {
        await bot.api.deleteForumTopic(chat_id, threadId)
        delNote = '🗑 Топик удалён.'
      } catch (e) {
        delNote = `⚠️ Топик не удалён (у бота есть право can_delete_messages?): ${escHtml(e instanceof Error ? e.message : String(e))}`
      }
      void bot.api.sendMessage(chat_id, `${note}\n${delNote}`, { parse_mode: 'HTML' }).catch(() => {})
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
        void bot.api
          .sendMessage(
            chat_id,
            `🔗 <b>Привязано</b>\n\n<code>${escHtml(key)}</code> → ${codePath(dir)}\n\nКак стартуем?`,
            { ...threadOpt, parse_mode: 'HTML', reply_markup: startChoiceKeyboard(key, dir) },
          )
          .catch(() => {})
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
      void say(await teardownBinding(key, binding))
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
    const branch = await gitBranch(binding.dir)
    const lines = [
      `📊 <b>${escHtml(key)}</b>`,
      '',
      `📁 ${codePath(binding.dir)}${branch ? ` <i>(${escHtml(branch)})</i>` : ''}`,
      '',
    ]
    if (session) {
      const pidState = session.pid
        ? alive(session.pid) ? `жив <i>(pid ${session.pid})</i>` : `<b>мёртв</b> <i>(pid ${session.pid})</i>`
        : 'pid неизвестен'
      const tmuxName = sessionName(key, binding.dir)
      lines.push(
        `🟢 claude: подключён, ${pidState}`,
        `🪟 tmux: <code>${escHtml(tmuxName)}</code>${session.pane ? ` <i>(${escHtml(session.pane)})</i>` : ''}`,
      )
      if (binding.sessionId) {
        lines.push(`🆔 session: <code>${escHtml(binding.sessionId)}</code>`)
      }
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
        lines.push('', ...parts.map(escHtml))
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

  if (cmd === 'compact' || cmd === 'clear' || cmd === 'esc' || cmd === 'enter' || cmd === 'restart' || cmd === 'model' || cmd === 'stop' || cmd === 'screen') {
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
        } else if (cmd === 'clear') {
          await sendKeys(s.pane, '/clear', 'Enter')
          void say('🧹 <b>История очищена.</b>')
        } else if (cmd === 'esc') {
          await sendKeys(s.pane, 'Escape')
          void say('⎋ <b>Esc</b> отправлен.')
        } else if (cmd === 'enter') {
          // Сабмитнуть то, что уже в строке ввода pane (напр. /compact, который
          // набрался, но не отправился) — голый Enter, без набора текста.
          await sendKeys(s.pane, 'Enter')
          void say('⏎ <b>Enter</b> отправлен.')
        } else if (cmd === 'screen') {
          // Universal 1:1 view of the pane — the escape hatch for any TUI state the picker
          // bridge doesn't recognize. Live, self-updating message with a Close button (deletes
          // it) instead of a one-shot photo, so the debug view doesn't pile up in history.
          await startLiveScreen(chat_id, threadId, s.pane)
          // drop the "/screen" command itself too (works where the bot can delete — groups; a
          // DM won't let a bot delete the user's message, hence best-effort).
          if (msgId != null) {
            void bot.api.deleteMessage(chat_id, msgId).catch(() => {})
          }
        } else if (cmd === 'model') {
          // Typed as real keystrokes (not a message-event) so the CLI opens its
          // native picker — pollScreens/detectPicker below turns it into buttons.
          await sendKeys(s.pane, '/model', 'Enter')
          void say('📋 <code>/model</code> отправлен — жди меню с кнопками.')
        } else if (cmd === 'stop') {
          if (!s.pid) {
            void say('⚠️ Стоп недоступен — не опознал процесс claude.')
            continue
          }
          void say('🛑 <b>Останавливаю</b> сессию… Если всплывёт вопрос про фоновые задачи — ответь кнопками, иначе через ~10с выйду сам.')
          expectedDisconnect.add(key)
          void stopSession(s.pane, s.pid, log)
            .then(ok => {
              if (!ok) {
                return void say('⚠️ Процесс не умер — глянь руками в tmux.')
              }
              // straight into the what-next choice — same keyboard as after /bind
              void bot.api
                .sendMessage(chat_id, '🛑 <b>Сессия остановлена.</b> Что дальше?', {
                  ...threadOpt, parse_mode: 'HTML', reply_markup: startChoiceKeyboard(key, binding.dir),
                })
                .catch(() => {})
            })
            .catch(e => say(`⚠️ Стоп не удался: ${escHtml(String(e))}`))
            .finally(() => setTimeout(() => expectedDisconnect.delete(key), 90_000))
        } else {
          if (!s.pid || !s.cmdline?.length) {
            void say('⚠️ Рестарт недоступен — не опознал процесс claude.')
            continue
          }
          void say('♻️ <b>Перезапускаю</b> сессию…')
          expectedDisconnect.add(key)
          const restartKeys = s.bindingKeys?.length ? s.bindingKeys : [key]
          void restartSession(s.pane, s.pid, s.cmdline, restartKeys, log)
            .then(() => say('♻️ Перезапуск отправлен.'))
            .catch(e => say(`⚠️ Рестарт не удался: ${escHtml(String(e))}`))
            .finally(() => setTimeout(() => expectedDisconnect.delete(key), 90_000))
        }
      } catch (e) {
        void say(`⚠️ <b>${escHtml(cmd)} не удалось</b>: ${escHtml(String(e))}`)
      }
    }
    return
  }

  // resume | new
  if (live.length > 0) {
    if (cmd === 'resume' && session?.pane) {
      // Live session → open the CLI's own /resume list and mirror EXACTLY what
      // it shows; taps drive it with arrow keys (nr: callback). In-place switch,
      // no process restart. Positions can't drift: buttons ARE the TUI's rows.
      const pane = session.pane
      await sendKeys(pane, '/resume', 'Enter')
      // ponytail: список грузится асинхронно ("Loading conversations…") — поллим до 12с вместо фикс. 3с
      let list: ReturnType<typeof parseResumeList> = undefined
      for (let i = 0; i < 12 && !list?.rows.length; i++) {
        await new Promise(r => setTimeout(r, 1000))
        list = parseResumeList(await capturePane(pane).catch(() => ''))
      }
      if (!list?.rows.length) {
        await sendKeys(pane, 'Escape').catch(() => {}) // не оставлять пикер открытым в чужом pane
        log(`resume picker parse failed for pane ${pane}`)
        void say('⚠️ Список сессий не открылся (агент занят?). Попробуй позже, глянь /screen, или /stop и затем /resume.')
        return
      }
      // ponytail: маленький viewport TUI — прокручиваем стрелками и собираем до 10; если всё влезло, не листаем
      const wanted = Math.min(list.count, 10)
      const all: (ResumeRow | undefined)[] = list.rows.length >= wanted ? [...list.rows] : []
      all[list.pos - 1] = list.rows[list.cursor]
      for (let g = 0; list.pos < wanted && all.filter(Boolean).length < wanted && g < 12; g++) {
        await sendKeys(pane, 'Down')
        await new Promise(r => setTimeout(r, 200))
        const next = parseResumeList(await capturePane(pane).catch(() => ''))
        if (!next) {
          break
        }
        list = next
        all[list.pos - 1] = list.rows[list.cursor]
      }
      for (let g = 0; list.pos > 1 && g < 12; g++) {
        await sendKeys(pane, 'Up')
        await new Promise(r => setTimeout(r, 200))
        const prev = parseResumeList(await capturePane(pane).catch(() => ''))
        if (!prev) {
          break
        }
        list = prev
      }
      const rows: ResumeRow[] = []
      for (const r of all) {
        if (!r || rows.length >= wanted) {
          break // дырка = сбой парса на этой позиции; индексы кнопок должны совпадать с абсолютными
        }
        rows.push(r)
      }
      const kb = new InlineKeyboard()
      rows.forEach((r, i) => {
        kb.text(`${r.title.slice(0, 40)} · ${r.meta.split('·')[0].trim()}`, `nr:${key}:${i}:${fnv1a(r.title)}`).row()
      })
      kb.text('✖️ Отмена', `nr:${key}:esc:00000000`).row()
      void bot.api
        .sendMessage(chat_id, `⏪ <b>Переключить сессию</b> <i>(${escHtml(list.total)}, без перезапуска)</i>`, {
          ...threadOpt, parse_mode: 'HTML', reply_markup: kb,
        })
        .catch(e => log(`native resume picker send failed: ${e}`))
      return
    }
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
  // /resume with several past sessions → picker (like claude --resume, but with
  // buttons); tap lands in the rs:/ns: callbacks below. /new and single-session
  // /resume keep the old instant path.
  if (cmd === 'resume') {
    const recent = recentSessions(binding.dir, 5)
    if (recent.length > 1) {
      void bot.api
        .sendMessage(chat_id, '⏪ <b>Какую сессию поднять?</b> (свежие сверху)', {
          ...threadOpt, parse_mode: 'HTML', reply_markup: startChoiceKeyboard(key, binding.dir),
        })
        .catch(e => log(`resume picker send failed: ${e}`))
      return
    }
  }
  await spawnSession(key, binding, cmd === 'resume' ? 'resume' : 'new', html => void say(html))
}

// "🆕 new or ⏪ which past session" keyboard — shown after /bind and on /resume.
function startChoiceKeyboard(key: string, dir: string): InlineKeyboard {
  const kb = new InlineKeyboard()
  kb.text('🆕 Новая сессия', `ns:${key}`).row()
  for (const r of recentSessions(dir, 5)) {
    const when = new Date(r.mtime).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    kb.text(`⏪ ${when} · ${r.snippet.slice(0, 40) || r.id.slice(0, 8)}`, `rs:${key}:${r.id}`).row()
  }
  return kb
}

bot.on('my_chat_member', ctx => {
  recordChat(String(ctx.chat.id), ctx.chat.type, chatLabel(ctx.chat), new Date().toISOString())
})

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

  if (cfg.modes.length > 1) {
    pendingModeChoice.set(key, { cfg, topicName, say })
    void bot.api
      .sendMessage(chat_id, modePromptText(cfg, 'Как поднять сессию для этого топика?'), {
        message_thread_id: threadId,
        parse_mode: 'HTML',
        reply_markup: modeKeyboard(key, cfg),
      })
      .catch(() => {})
    return
  }

  beginTopicSession(key, cfg, cfg.modes[0], topicName, say)
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
  const path = await doDownload({ file_id: voice.file_id }).catch(() => undefined)
  const transcript = path ? await transcribeVoice(path) : undefined
  await handleInbound({
    ctx,
    text: transcript ?? ctx.message.caption ?? '(voice message)',
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
  const sc = /^scrclose:(\S+)$/.exec(ctx.callbackQuery.data)
  if (sc) {
    const v = closeLiveScreen(sc[1])
    if (v) {
      await bot.api.deleteMessage(v.chatId, v.msgId).catch(() => {})
    }
    await ctx.answerCallbackQuery({ text: 'Закрыто' }).catch(() => {})
    return
  }
  const tm = /^topicmode:(.+):(folder|worktree)$/.exec(ctx.callbackQuery.data)
  if (tm) {
    const [, key, modeStr] = tm
    const mode = modeStr as TrustedGroupMode
    const pending = pendingModeChoice.get(key)
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Уже выбрано или устарело' }).catch(() => {})
      return
    }
    if (!isAdmin(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Нет прав' }).catch(() => {})
      return
    }
    pendingModeChoice.delete(key)
    await ctx.answerCallbackQuery({ text: MODE_LABEL[mode] }).catch(() => {})
    await ctx.editMessageText(`${MODE_LABEL[mode]} — выбрано.`).catch(() => {})
    beginTopicSession(key, pending.cfg, mode, pending.topicName, pending.say)
    return
  }
  const td = /^topicdir:(.+)$/.exec(ctx.callbackQuery.data)
  if (td) {
    const [, key] = td
    const pending = pendingModeChoice.get(key)
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Уже выбрано или устарело' }).catch(() => {})
      return
    }
    if (!isAdmin(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Нет прав' }).catch(() => {})
      return
    }
    pendingModeChoice.delete(key)
    await ctx.answerCallbackQuery({ text: OWN_DIR_LABEL }).catch(() => {})
    await ctx.editMessageText(`${OWN_DIR_LABEL} — выбрано.`).catch(() => {})
    pending.say('📁 Пришли папку — как в <code>/bind</code>: имя в ~/projects или абсолютный путь.')
    pendingTopics.set(key, { cfg: pending.cfg, mode: 'folder', topicName: pending.topicName, say: pending.say })
    return
  }
  // nr:<key>:<idx|esc>:<title-hash> = drive the CLI's own /resume list by arrows
  const nr = /^nr:(.+):(\d+|esc):([0-9a-f]{8})$/.exec(ctx.callbackQuery.data)
  if (nr) {
    const [, key, idxStr, hash] = nr
    const senderId = String(ctx.from.id)
    const binding = loadBindings()[key]
    if (!binding) {
      await ctx.answerCallbackQuery({ text: 'Привязка исчезла' }).catch(() => {})
      return
    }
    if (!isAdmin(senderId) && !binding.allow?.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Нет доступа' }).catch(() => {})
      return
    }
    const conn = connsForBinding(key, binding.dir)[0]
    const pane = conn ? router.get(conn)?.pane : undefined
    if (!pane) {
      await ctx.answerCallbackQuery({ text: 'Сессия пропала — вызови /resume заново' }).catch(() => {})
      return
    }
    if (idxStr === 'esc') {
      await sendKeys(pane, 'Escape')
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.editMessageText('✖️ Закрыто.').catch(() => {})
      return
    }
    const idx = Number(idxStr)
    const stale = async (why: string) => {
      await ctx.answerCallbackQuery({ text: why }).catch(() => {})
    }
    let list = parseResumeList(await capturePane(pane).catch(() => ''))
    if (!list || idx >= list.count) {
      return stale('Список изменился — вызови /resume заново')
    }
    // move cursor to the row (абсолютная позиция из заголовка "(N of M)" — строка может
    // быть за пределами viewport), re-verify what's actually highlighted, only then Enter
    const moves = idx + 1 - list.pos
    for (let i = 0; i < Math.abs(moves); i++) {
      await sendKeys(pane, moves > 0 ? 'Down' : 'Up')
      await new Promise(r => setTimeout(r, 150))
    }
    await new Promise(r => setTimeout(r, 400))
    list = parseResumeList(await capturePane(pane).catch(() => ''))
    if (!list || list.pos !== idx + 1 || fnv1a(list.rows[list.cursor].title) !== hash) {
      return stale('Не попал по курсору — вызови /resume заново')
    }
    const title = list.rows[list.cursor].title
    await sendKeys(pane, 'Enter')
    await ctx.answerCallbackQuery({ text: 'Переключаю…' }).catch(() => {})
    await ctx.editMessageText(`⏪ Переключился: <b>${escHtml(title)}</b>`, { parse_mode: 'HTML' }).catch(() => {})
    return
  }
  // rs:<key>:<uuid> = resume that session; ns:<key> = start fresh
  const start = /^rs:(.+):([0-9a-f-]{36})$/.exec(ctx.callbackQuery.data) ?? /^ns:(.+)$/.exec(ctx.callbackQuery.data)
  if (start) {
    const [, key, sessionId] = start
    const senderId = String(ctx.from.id)
    const reg = loadBindings()
    const binding = reg[key]
    if (!binding) {
      await ctx.answerCallbackQuery({ text: 'Привязка исчезла' }).catch(() => {})
      return
    }
    if (!isAdmin(senderId) && !binding.allow?.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Нет доступа' }).catch(() => {})
      return
    }
    if (sessionId) {
      binding.sessionId = sessionId
      saveBindings(reg)
    }
    await ctx.answerCallbackQuery({ text: sessionId ? 'Поднимаю…' : 'Запускаю…' }).catch(() => {})
    // a live session in the way → graceful stop before switching
    const liveConns = connsForBinding(key, binding.dir)
    if (liveConns.length > 0) {
      expectedDisconnect.add(key)
      setTimeout(() => expectedDisconnect.delete(key), 90_000)
      for (const conn of liveConns) {
        const s = router.get(conn)
        if (s?.pane && s.pid) {
          await ctx.editMessageText('🛑 Останавливаю текущую сессию…', { parse_mode: 'HTML' }).catch(() => {})
          const ok = await stopSession(s.pane, s.pid, log).catch(() => false)
          if (!ok) {
            await ctx.editMessageText('⚠️ Не смог остановить текущую сессию — глянь в tmux.', { parse_mode: 'HTML' }).catch(() => {})
            return
          }
        }
      }
    }
    await ctx
      .editMessageText(
        sessionId ? `⏪ Возобновляю <code>${sessionId.slice(0, 8)}…</code>` : '🆕 Запускаю новую сессию…',
        { parse_mode: 'HTML' },
      )
      .catch(() => {})
    const target = keyToTarget(key)
    await spawnSession(key, binding, sessionId ? 'resume' : 'new', html =>
      void bot.api.sendMessage(target.chat_id, html, {
        ...(target.thread_id != null ? { message_thread_id: target.thread_id } : {}),
        parse_mode: 'HTML',
      }).catch(() => {}),
    )
    return
  }
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
          void reviveBoundSessions() // host reboot: tmux died with it — bring sessions back
          // scoped-списки (например, от старого бота) перекрывают default в DM/группах — чистим
          void bot.api.deleteMyCommands({ scope: { type: 'all_private_chats' } }).catch(e => log(`deleteMyCommands: ${e}`))
          void bot.api.deleteMyCommands({ scope: { type: 'all_group_chats' } }).catch(e => log(`deleteMyCommands: ${e}`))
          void bot.api.setMyCommands([
            { command: 'status', description: 'Статус сессии (папка/tmux/claude/лимиты)' },
            { command: 'resume', description: 'Поднять сессию (с выбором, какую)' },
            { command: 'screen', description: 'Показать экран сессии как есть' },
            { command: 'new', description: 'Запустить свежую сессию' },
            { command: 'compact', description: 'Отправить /compact в сессию' },
            { command: 'clear', description: 'Очистить историю сессии' },
            { command: 'esc', description: 'Прервать текущий ход' },
            { command: 'enter', description: 'Отправить Enter (сабмитнуть строку ввода)' },
            { command: 'model', description: 'Выбрать модель (интерактивно, кнопками)' },
            { command: 'stop', description: 'Остановить сессию (graceful /exit → Ctrl-C)' },
            { command: 'restart', description: 'Аккуратный перезапуск сессии' },
            { command: 'bind', description: 'Привязать этот чат/топик к папке проекта (админ)' },
            { command: 'unbind', description: 'Снять привязку (админ)' },
            { command: 'delete', description: 'Снять привязку + удалить топик (админ)' },
            { command: 'allow', description: 'Дать доступ пользователю к этому биндингу (админ)' },
          ]).catch(e => log(`setMyCommands: ${e}`))
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
