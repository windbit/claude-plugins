// A binding key is the canonical string form stored in bindings.json and used for
// routing: "-100123/42" topic, "-100123" group/General, "dm:123" DM (DM chat_id ==
// user_id). Types below name the two shapes it converts between.

/** Fields taken off an inbound Telegram message to compute its binding key. */
export type InboundRef = { chatType: string; chatId: string; threadId?: number }

/** A resolved Telegram send target: chat_id as the Bot API wants (string) plus an
 *  optional forum topic. No thread_id = a DM or a plain group/General. */
export type Target = { chat_id: string; thread_id?: number }

export function messageKey(m: InboundRef): string {
  if (m.chatType === 'private') return `dm:${m.chatId}`
  return m.threadId != null ? `${m.chatId}/${m.threadId}` : m.chatId
}

export function keyToTarget(key: string): Target {
  const dm = /^dm:(\d+)$/.exec(key)
  if (dm) return { chat_id: dm[1] }
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(key)
  if (!m) throw new Error(`bad binding key "${key}"`)
  return m[2] != null ? { chat_id: m[1], thread_id: Number(m[2]) } : { chat_id: m[1] }
}

// Resolve where a session (bound to `keys`) should send a reply. The reply tool's
// args arrive as strings; when absent, derive the target from the single/only key.
export function targetFor(keys: string[], chatId?: string, threadId?: string): Target {
  if (chatId) {
    if (threadId != null && threadId !== '') return { chat_id: chatId, thread_id: Number(threadId) }
    const topics = keys.map(keyToTarget).filter(t => t.chat_id === chatId && t.thread_id != null)
    if (topics.length === 1) return topics[0]
    if (topics.length > 1) throw new Error(`several topics bound for chat ${chatId} — pass thread_id`)
    return { chat_id: chatId }
  }
  if (keys.length === 1) return keyToTarget(keys[0])
  throw new Error(
    keys.length === 0
      ? 'this project is not bound to any chat — use /bind in Telegram'
      : 'several chats bound — pass chat_id (and thread_id) from the inbound tag',
  )
}
