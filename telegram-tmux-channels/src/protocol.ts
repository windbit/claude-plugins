// NDJSON protocol between stub and hub over the hub.sock unix socket.
import type { AgentKind } from './agents/types'
import type { SessionCron } from './session-crons'

export type SessionInfo = {
  agent?: AgentKind // absent on an old stub means Claude
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
  // Every hook message also carries the CURRENT session id (hook payload `session_id`), so the
  // hub can keep bindings.json in sync: /clear or an in-TUI /resume starts a different session
  // and there is no spawn for the hub to learn it from — without this the binding goes stale and
  // the next restart resumes the wrong conversation.
  | { op: 'subagent'; action: 'describe'; bindingKeys: string[]; sessionId?: string; promptId: string; description: string }
  | { op: 'subagent'; action: 'start'; bindingKeys: string[]; sessionId?: string; promptId: string; agentId: string; agentType: string }
  | { op: 'subagent'; action: 'stop'; bindingKeys: string[]; sessionId?: string; agentId: string }
  // Stop = the turn ended (Claude finished responding) — closes the current batch so the
  // NEXT subagent start opens a fresh message instead of appending to a finished one.
  // `bg` = the Stop payload's background_tasks: the shells STILL running. Completed ones are
  // dropped from it, so "listed before, absent now" is the only completion signal there is.
  | { op: 'subagent'; action: 'turnend'; bindingKeys: string[]; sessionId?: string; bg?: { command: string; description?: string }[]; crons?: SessionCron[] }
  // TaskCreate/TaskUpdate (the todo-list tool) — unlike subagents, id/subject/status come
  // straight off one event each, no promptId correlation needed
  | { op: 'task'; action: 'create'; bindingKeys: string[]; sessionId?: string; taskId: string; subject: string }
  | { op: 'task'; action: 'update'; bindingKeys: string[]; sessionId?: string; taskId: string; status: string }
  // Skill tool invocation (PreToolUse ^Skill$) — no lifecycle, one event per call
  | { op: 'skill'; bindingKeys: string[]; sessionId?: string; skill: string; args?: string }
  // TodoWrite (the ⊡/✓ checklist tool, distinct from TaskCreate/Update) — carries the FULL
  // list on every call, so no per-item lifecycle; the hub just re-renders one message
  | { op: 'todo'; bindingKeys: string[]; sessionId?: string; todos: { content: string; status: string }[] }
  // Bash with run_in_background (PreToolUse ^Bash$, filtered hook-side) — the LAUNCH half, so
  // the line shows up mid-turn. Completion arrives later via turnend's `bg` above.
  // Without this the TUI's "Background tasks" were invisible in Telegram entirely.
  | { op: 'bg'; bindingKeys: string[]; sessionId?: string; command: string; description?: string }
  // Codex exposes compaction lifecycle through PreCompact/PostCompact hooks but no progress
  // percentage.  Keeping this separate from pane scraping makes start/done deterministic.
  | { op: 'compaction'; phase: 'start' | 'done'; bindingKeys: string[]; sessionId?: string; trigger?: 'manual' | 'auto' }

  // Подтверждение доставки входящего. Стаб отдаёт сообщение в Claude Code MCP-уведомлением,
  // и до сих пор его провал был виден только в логе стаба: хаб считал отправку удавшейся и
  // догадывался о судьбе сообщения по транскрипту. Здесь — прямой ответ вместо догадки.
  // Необязательное: старые стабы в уже живых сессиях его не шлют, и хаб откатывается
  // на проверку по транскрипту.
  | { op: 'ack'; id: string; ok: boolean; error?: string }

export type HubToStub =
  // id есть только у входящих, чью доставку сторожим; стаб отвечает на него 'ack'
  | { op: 'event'; kind: 'message'; content: string; meta: Record<string, string>; id?: string }
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
