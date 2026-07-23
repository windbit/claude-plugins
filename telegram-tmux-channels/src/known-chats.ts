// known-chats.json — every chat the bot has seen (id, type, title), so a new
// group's chat_id is one `cat` away instead of hunting through raw updates.
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './paths'
import { safeJsonParse } from './util'

export const KNOWN_CHATS_FILE = join(STATE_DIR, 'known-chats.json')

// Topic titles come only from updates (created/edited) — the Bot API can't look one up
// later. A topic first seen through a plain message is recorded id-only, until it's renamed.
export type KnownTopic = { title?: string; firstSeen: string; lastSeen: string }

export type KnownChat = {
  type: string
  title: string
  firstSeen: string
  lastSeen: string
  topics?: Record<string, KnownTopic>
}

export function loadKnownChats(): Record<string, KnownChat> {
  let raw: string
  try {
    raw = readFileSync(KNOWN_CHATS_FILE, 'utf8')
  } catch {
    return {}
  }
  return safeJsonParse<Record<string, KnownChat>>(raw) ?? {}
}

function saveKnownChats(reg: Record<string, KnownChat>): void {
  writeFileSync(KNOWN_CHATS_FILE + '.tmp', JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
  renameSync(KNOWN_CHATS_FILE + '.tmp', KNOWN_CHATS_FILE)
}

export function chatLabel(chat: { type: string; title?: string; first_name?: string; username?: string }): string {
  if (chat.title) {
    return chat.title
  }
  return [chat.first_name, chat.username ? `@${chat.username}` : undefined].filter(Boolean).join(' ') || chat.type
}

// Only writes when a chat is new or its label changed — not on every message.
export function recordChat(chatId: string, type: string, title: string, now: string): void {
  const reg = loadKnownChats()
  const existing = reg[chatId]
  if (existing && existing.title === title && existing.type === type) {
    return
  }
  reg[chatId] = { ...existing, type, title, firstSeen: existing?.firstSeen ?? now, lastSeen: now }
  saveKnownChats(reg)
}

// Same write-on-change rule as recordChat. `title` undefined = "seen it, name unknown":
// never overwrites a name we already learned from a created/edited update. Returns
// undefined when nothing changed (→ no write). Pure — tested in known-chats.test.ts.
export function mergeTopic(
  existing: KnownTopic | undefined,
  title: string | undefined,
  now: string,
): KnownTopic | undefined {
  if (existing && (title === undefined || existing.title === title)) {
    return undefined
  }
  const kept = title ?? existing?.title
  return { ...(kept ? { title: kept } : {}), firstSeen: existing?.firstSeen ?? now, lastSeen: now }
}

export function recordTopic(chatId: string, threadId: number, title: string | undefined, now: string): void {
  const reg = loadKnownChats()
  const chat = reg[chatId]
  if (!chat) {
    return // recordChat runs first on every path that knows the chat
  }
  const topics = chat.topics ?? {}
  const merged = mergeTopic(topics[String(threadId)], title, now)
  if (!merged) {
    return
  }
  topics[String(threadId)] = merged
  reg[chatId] = { ...chat, topics }
  saveKnownChats(reg)
}

export function topicTitle(chatId: string, threadId: number): string | undefined {
  return loadKnownChats()[chatId]?.topics?.[String(threadId)]?.title
}
