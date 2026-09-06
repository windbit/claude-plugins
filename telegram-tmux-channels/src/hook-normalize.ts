import type { StubToHub } from './protocol'
import { parseSessionCrons } from './session-crons'

export type HookMode =
  | 'describe' | 'start' | 'stop' | 'turnend'
  | 'task-create' | 'task-update' | 'skill' | 'todo' | 'bg'
  | 'codex-plan' | 'codex-skill' | 'compaction-start' | 'compaction-done'

/** Тип агента, которого поднимает Workflow: хаб их не отслеживает — статус берётся из пейна. */
export const WORKFLOW_SUBAGENT = 'workflow-subagent'

export function normalizeHookMessage(
  mode: HookMode,
  data: Record<string, unknown>,
  bindingKeys: string[],
): StubToHub | undefined {
  let msg: StubToHub | undefined
  const toolInput = data.tool_input as Record<string, unknown> | undefined
  const toolResponse = data.tool_response as Record<string, unknown> | undefined

  if (mode === 'turnend') {
    const bg = (Array.isArray(data.background_tasks) ? (data.background_tasks as Record<string, unknown>[]) : [])
      .filter(b => b.type === 'shell')
      .map(b => ({ command: String(b.command ?? ''), ...(b.description ? { description: String(b.description) } : {}) }))
      .filter(b => b.command)
    // Кроны/лупы сессии едут тем же сообщением: Stop приходит на каждом конце хода, и это
    // единственный payload, где Claude Code их отдаёт. Хабу они нужны, чтобы не погасить по
    // простою сессию, вместе с которой умрёт и расписание.
    msg = { op: 'subagent', action: 'turnend', bindingKeys, bg, crons: parseSessionCrons(data.session_crons) }
  } else if (mode === 'compaction-start' || mode === 'compaction-done') {
    const trigger = data.trigger === 'manual' || data.trigger === 'auto' ? data.trigger : undefined
    msg = { op: 'compaction', phase: mode === 'compaction-start' ? 'start' : 'done', bindingKeys, ...(trigger ? { trigger } : {}) }
  } else if (mode === 'task-create') {
    const task = toolResponse?.task as Record<string, unknown> | undefined
    const taskId = String(task?.id ?? '')
    const subject = String(toolInput?.subject ?? '')
    if (taskId && subject) msg = { op: 'task', action: 'create', bindingKeys, taskId, subject }
  } else if (mode === 'task-update') {
    const statusChange = toolResponse?.statusChange as Record<string, unknown> | undefined
    const taskId = String(toolInput?.taskId ?? '')
    const status = String(statusChange?.to ?? toolInput?.status ?? '')
    if (taskId && status) msg = { op: 'task', action: 'update', bindingKeys, taskId, status }
  } else if (mode === 'codex-plan') {
    const raw = Array.isArray(toolInput?.plan) ? (toolInput.plan as Record<string, unknown>[]) : []
    const todos = raw.map(v => ({ content: String(v.step ?? ''), status: String(v.status ?? 'pending') })).filter(v => v.content)
    if (todos.length) msg = { op: 'todo', bindingKeys, todos }
  } else if (mode === 'skill') {
    const skill = String(toolInput?.skill ?? '')
    if (skill) msg = { op: 'skill', bindingKeys, skill, ...(toolInput?.args ? { args: String(toolInput.args) } : {}) }
  } else if (mode === 'codex-skill') {
    const prompt = String(data.prompt ?? '')
    const m = /^\s*\$([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?/.exec(prompt)
    if (m) msg = { op: 'skill', bindingKeys, skill: m[1]!, ...(m[2]?.trim() ? { args: m[2].trim() } : {}) }
  } else if (mode === 'todo') {
    const raw = Array.isArray(toolInput?.todos) ? (toolInput.todos as Record<string, unknown>[]) : []
    const todos = raw.map(v => ({ content: String(v.content ?? ''), status: String(v.status ?? 'pending') })).filter(v => v.content)
    if (todos.length) msg = { op: 'todo', bindingKeys, todos }
  } else if (mode === 'bg') {
    if (toolInput?.run_in_background === true) {
      const command = String(toolInput.command ?? '')
      if (command) msg = { op: 'bg', bindingKeys, command, ...(toolInput.description ? { description: String(toolInput.description) } : {}) }
    }
  } else if (mode === 'describe') {
    const promptId = String(data.prompt_id ?? data.turn_id ?? data.tool_use_id ?? '')
    const description = String(toolInput?.description ?? toolInput?.message ?? toolInput?.task_name ?? '')
    if (promptId && description) msg = { op: 'subagent', action: 'describe', bindingKeys, promptId, description }
  } else if (mode === 'start') {
    const agentId = String(data.agent_id ?? '')
    if (agentId) msg = {
      op: 'subagent', action: 'start', bindingKeys,
      promptId: String(data.prompt_id ?? data.turn_id ?? ''), agentId,
      agentType: String(data.agent_type ?? 'agent'),
    }
  } else {
    // SubagentStop приходит НЕ только на конец агента: пока сабагент работает, Claude Code шлёт
    // то же событие каждые ~30 с как отметку прогресса — со свежим случайным `agent_id`, ПУСТЫМ
    // `agent_type` и промежуточной строкой в `last_assistant_message` («Reading AGENTS.md…»).
    // Настоящий конец отличается непустым типом (замер 03.09: 5 тиков и 1 настоящий стоп).
    // Тики стоили 445 событий в час на одного живого агента: сокет и процесс хука на каждое.
    const agentId = String(data.agent_id ?? '')
    const agentType = String(data.agent_type ?? '')
    // Агентов воркфлоу хаб не отслеживает вовсе (их старт он пропускает — имя приходит скрейпом
    // пейна), значит и остановку сопоставлять не с чем: она доезжает до хаба только чтобы лечь
    // строкой «found=false». Один прогон воркфлоу давал 144 таких за час (05.09, habebe-trader).
    if (agentId && agentType && agentType !== WORKFLOW_SUBAGENT) {
      msg = { op: 'subagent', action: 'stop', bindingKeys, agentId }
    }
  }

  const sessionId = String(data.session_id ?? '')
  return msg && sessionId && 'bindingKeys' in msg ? { ...msg, sessionId } : msg
}
