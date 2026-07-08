// known-chats.json — every chat the bot has seen (id, type, title), so a new
// group's chat_id is one `cat` away instead of hunting through raw updates.
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './paths'
import { safeJsonParse } from './util'

export const KNOWN_CHATS_FILE = join(STATE_DIR, 'known-chats.json')

export type KnownChat = { type: string; title: string; firstSeen: string; lastSeen: string }

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
  reg[chatId] = { type, title, firstSeen: existing?.firstSeen ?? now, lastSeen: now }
  saveKnownChats(reg)
}
