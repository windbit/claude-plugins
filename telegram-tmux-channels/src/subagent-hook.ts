#!/usr/bin/env bun
// Claude Code hook target for both the subagent-status and task-list status messages.
// Runs as a short-lived process (spawned fresh per event, unlike the long-lived MCP
// stub) — reads the hook JSON off stdin, connects to hub.sock, sends one line, exits.
// Never blocks Claude Code: hard timeout, all failures swallowed.
//
// Real hook payload field names (verified empirically — NOT what the docs' prose implies):
//   PreToolUse (tool_name Agent/Task): prompt_id, tool_input.description
//   SubagentStart: prompt_id, agent_id, agent_type (no description — must correlate via prompt_id)
//   SubagentStop: agent_id
//   Stop: turn end — no fields we need, just the signal that the batch is closed
//   PostToolUse(TaskCreate): tool_input.subject, tool_response.task.id
//   PostToolUse(TaskUpdate): tool_input.taskId, tool_response.statusChange.to
import { SOCK_PATH } from './paths'
import { encode, type StubToHub } from './protocol'

const mode = process.argv[2] // 'describe' | 'start' | 'stop' | 'turnend' | 'task-create' | 'task-update'
const bindingKeys = (process.env.TELEGRAM_BINDING_KEYS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const VALID_MODES = new Set(['describe', 'start', 'stop', 'turnend', 'task-create', 'task-update'])

async function main(): Promise<void> {
  if (bindingKeys.length === 0 || !mode || !VALID_MODES.has(mode)) {
    return
  }
  let raw = ''
  for await (const chunk of Bun.stdin.stream()) {
    raw += Buffer.from(chunk).toString()
  }
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }

  let msg: StubToHub
  if (mode === 'turnend') {
    msg = { op: 'subagent', action: 'turnend', bindingKeys }
  } else if (mode === 'task-create') {
    const toolInput = data.tool_input as Record<string, unknown> | undefined
    const toolResponse = data.tool_response as Record<string, unknown> | undefined
    const task = toolResponse?.task as Record<string, unknown> | undefined
    const taskId = String(task?.id ?? '')
    const subject = String(toolInput?.subject ?? '')
    if (!taskId || !subject) {
      return
    }
    msg = { op: 'task', action: 'create', bindingKeys, taskId, subject }
  } else if (mode === 'task-update') {
    const toolInput = data.tool_input as Record<string, unknown> | undefined
    const toolResponse = data.tool_response as Record<string, unknown> | undefined
    const statusChange = toolResponse?.statusChange as Record<string, unknown> | undefined
    const taskId = String(toolInput?.taskId ?? '')
    const status = String(statusChange?.to ?? toolInput?.status ?? '')
    if (!taskId || !status) {
      return
    }
    msg = { op: 'task', action: 'update', bindingKeys, taskId, status }
  } else if (mode === 'describe') {
    const promptId = String(data.prompt_id ?? '')
    const toolInput = data.tool_input as Record<string, unknown> | undefined
    const description = String(toolInput?.description ?? '')
    if (!promptId || !description) {
      return
    }
    msg = { op: 'subagent', action: 'describe', bindingKeys, promptId, description }
  } else if (mode === 'start') {
    const agentId = String(data.agent_id ?? '')
    if (!agentId) {
      return
    }
    msg = {
      op: 'subagent',
      action: 'start',
      bindingKeys,
      promptId: String(data.prompt_id ?? ''),
      agentId,
      agentType: String(data.agent_type ?? 'agent'),
    }
  } else {
    const agentId = String(data.agent_id ?? '')
    if (!agentId) {
      return
    }
    msg = { op: 'subagent', action: 'stop', bindingKeys, agentId }
  }

  await new Promise<void>(resolve => {
    let done = false
    const finish = () => {
      if (!done) {
        done = true
        resolve()
      }
    }
    setTimeout(finish, 2000)
    Bun.connect<undefined>({
      unix: SOCK_PATH,
      socket: {
        open(sock) {
          sock.write(encode(msg))
          sock.end()
          finish()
        },
        data() {},
        close: finish,
        error: finish,
      },
    }).catch(finish)
  })
}

await main()
