// NDJSON protocol between stub and hub over the hub.sock unix socket.

export type SessionInfo = {
  pane?: string
  pid?: number
  cmdline?: string[]
  cwd?: string
  bindingKeys?: string[] // from TELEGRAM_BINDING_KEYS env, set by the hub at launch
}

export type RpcMethod =
  | 'reply'
  | 'react'
  | 'edit_message'
  | 'download_attachment'
  | 'permission_request'

export type StubToHub =
  | { op: 'subscribe'; session: SessionInfo }
  | { op: 'rpc'; id: number; method: RpcMethod; params: Record<string, unknown> }
  // 'describe' = PreToolUse(Agent/Task) — carries the human description, correlated to the
  // later SubagentStart by promptId (SubagentStart itself only has agent_id/agent_type, no text)
  | { op: 'subagent'; action: 'describe'; bindingKeys: string[]; promptId: string; description: string }
  | { op: 'subagent'; action: 'start'; bindingKeys: string[]; promptId: string; agentId: string; agentType: string }
  | { op: 'subagent'; action: 'stop'; bindingKeys: string[]; agentId: string }
  // Stop = the turn ended (Claude finished responding) — closes the current batch so the
  // NEXT subagent start opens a fresh message instead of appending to a finished one
  | { op: 'subagent'; action: 'turnend'; bindingKeys: string[] }
  // TaskCreate/TaskUpdate (the todo-list tool) — unlike subagents, id/subject/status come
  // straight off one event each, no promptId correlation needed
  | { op: 'task'; action: 'create'; bindingKeys: string[]; taskId: string; subject: string }
  | { op: 'task'; action: 'update'; bindingKeys: string[]; taskId: string; status: string }

export type HubToStub =
  | { op: 'event'; kind: 'message'; content: string; meta: Record<string, string> }
  | { op: 'event'; kind: 'permission'; request_id: string; behavior: 'allow' | 'deny' }
  | { op: 'result'; id: number; ok: boolean; result?: string; error?: string }

export function encode(m: unknown): string {
  return JSON.stringify(m) + '\n'
}

export function makeLineDecoder<T>(
  onMsg: (m: T) => void,
  onErr: (e: Error) => void,
): (chunk: string) => void {
  let buf = ''
  return chunk => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) {
        continue
      }
      try {
        onMsg(JSON.parse(line) as T)
      } catch (e) {
        onErr(e as Error)
      }
    }
  }
}
