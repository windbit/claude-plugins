// Binding key: "-100123/42" topic, "-100123" group/General, "dm:123" DM
// (DM chat_id == user_id). The hub keeps the key → project dir map in bindings.json.

export function messageKey(m: { chatType: string; chatId: string; threadId?: number }): string {
  if (m.chatType === 'private') return `dm:${m.chatId}`
  return m.threadId != null ? `${m.chatId}/${m.threadId}` : m.chatId
}

export function keyToTarget(key: string): { chat_id: string; thread_id?: number } {
  const dm = /^dm:(\d+)$/.exec(key)
  if (dm) return { chat_id: dm[1] }
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(key)
  if (!m) throw new Error(`bad binding key "${key}"`)
  return m[2] != null ? { chat_id: m[1], thread_id: Number(m[2]) } : { chat_id: m[1] }
}

// Where a session in `dir` sends its reply: explicit args, else the dir's single key.
export function targetFor(
  keys: string[],
  chat_id?: string,
  thread_id?: string,
): { chat_id: string; thread_id?: number } {
  if (chat_id) {
    if (thread_id != null && thread_id !== '') return { chat_id, thread_id: Number(thread_id) }
    const topics = keys.map(keyToTarget).filter(t => t.chat_id === chat_id && t.thread_id != null)
    if (topics.length === 1) return topics[0]
    if (topics.length > 1) throw new Error(`several topics bound for chat ${chat_id} — pass thread_id`)
    return { chat_id }
  }
  if (keys.length === 1) return keyToTarget(keys[0])
  throw new Error(
    keys.length === 0
      ? 'this project is not bound to any chat — use /bind in Telegram'
      : 'several chats bound — pass chat_id (and thread_id) from the inbound tag',
  )
}
