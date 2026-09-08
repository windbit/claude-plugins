// Atomic file-backed persistence for hub state that must survive a restart. Today: the
// reply-fallback markers plus the typed interaction registry (editable messages, menus, live
// views and multi-step input). Feature code keeps its ergonomic Maps; this is the durable snapshot.
//
// One JSON snapshot under STATE_DIR, written tmp→rename so a crash mid-write can't leave a
// half-file, debounced so a burst of updates doesn't thrash the disk. In-memory maps stay the
// source of truth at runtime; this only mirrors them to disk and reloads on boot.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { STATE_DIR } from './paths'
import { join } from 'path'
import type { Picker } from './picker'
import type { TrustedGroupConfig } from './trusted-groups'
import type { PersistedInteraction } from './interaction-registry'
import type { ReplyContext } from './reply-context'

type PendingAnswer = { dir: string; at: number }
// An open TUI picker mirrored to Telegram buttons. Keyed by tmux pane. `key` (the binding) lets us
// reject a tap if the pane got recycled to a different session before the poll loop reconciled.
export type PersistedPicker = {
  chatId: string; threadId?: number; msgId: number; hash: string; token: string; picker: Picker; key: string; at: number
}
export type HubState = {
  version: 1
  pendingAnswer: Record<string, PendingAnswer>
  lastFallback: Record<string, string>
  pickers: Record<string, PersistedPicker>
  pendingModes: Record<string, PersistedPendingMode>
  queuedMessages: Record<string, PersistedInbound[]>
  launchCaptures: Record<string, PersistedLaunchCapture>
  interactions: Record<string, PersistedInteraction>
  errors: Record<string, PersistedError>
}

// Какой баннер ошибки уже показан в чате. Переживает рестарт хаба: иначе поднявшийся хаб
// видит в пейне ту же стоящую ошибку как новую и объявляет её заново, на КАЖДЫЙ рестарт.
export type PersistedError = { err: string; at: number }

export type PersistedPendingMode = { cfg: TrustedGroupConfig; topicName: string; chatId: string; threadId: number; agent?: 'claude' | 'codex'; hookOff?: boolean }
export type PersistedInbound = { text: string; chatId: string; threadId?: number; senderId: string; username?: string; msgId?: number; at: number; literal?: boolean; reply?: ReplyContext }
// A fresh launch has no session id yet. Preserve the pre-launch rollout ids so
// a hub restart can continue the exact capture instead of guessing the newest
// conversation in a shared directory.
export type PersistedLaunchCapture = { beforeIds: string[]; at: number }

const empty = (): HubState => ({ version: 1, pendingAnswer: {}, lastFallback: {}, pickers: {}, pendingModes: {}, queuedMessages: {}, launchCaptures: {}, interactions: {}, errors: {} })

export class HubStateRepository {
  private state: HubState = empty()
  private timer: ReturnType<typeof setTimeout> | null = null
  private log: (s: string) => void
  private dir: string
  private file: string
  private tmp: string

  constructor(log: (s: string) => void = () => {}, dir: string = STATE_DIR) {
    this.log = log
    this.dir = dir
    this.file = join(dir, 'hub-state.json')
    this.tmp = `${this.file}.tmp`
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<HubState>
      if (raw && raw.version === 1) {
        // pick known keys only — don't spread `...raw`, or a removed/old field (e.g. a legacy
        // `permissions` bucket) rides forward and gets re-persisted forever.
        this.state = {
          version: 1,
          pendingAnswer: raw.pendingAnswer ?? {},
          lastFallback: raw.lastFallback ?? {},
          pickers: raw.pickers ?? {},
          pendingModes: raw.pendingModes ?? {},
          queuedMessages: raw.queuedMessages ?? {},
          launchCaptures: raw.launchCaptures ?? {},
          interactions: raw.interactions ?? {},
          errors: raw.errors ?? {},
        }
      }
    } catch {} // no file / corrupt → start empty
  }

  // hydrate live Maps on boot
  pendingEntries(): [string, PendingAnswer][] { return Object.entries(this.state.pendingAnswer) }
  fallbackEntries(): [string, string][] { return Object.entries(this.state.lastFallback) }

  setPending(key: string, v: PendingAnswer): void { this.state.pendingAnswer[key] = v; this.schedule() }
  delPending(key: string): void { delete this.state.pendingAnswer[key]; this.schedule() }
  setFallback(key: string, text: string): void { this.state.lastFallback[key] = text; this.schedule() }

  errorEntries(): [string, PersistedError][] { return Object.entries(this.state.errors) }
  setError(pane: string, v: PersistedError): void { this.state.errors[pane] = v; this.schedule() }
  delError(pane: string): void { delete this.state.errors[pane]; this.schedule() }

  pickerEntries(): [string, PersistedPicker][] { return Object.entries(this.state.pickers) }
  setPicker(pane: string, v: PersistedPicker): void { this.state.pickers[pane] = v; this.schedule() }
  delPicker(pane: string): void { delete this.state.pickers[pane]; this.schedule() }

  pendingModeEntries(): [string, PersistedPendingMode][] { return Object.entries(this.state.pendingModes) }
  setPendingMode(key: string, v: PersistedPendingMode): void { this.state.pendingModes[key] = v; this.schedule() }
  delPendingMode(key: string): void { delete this.state.pendingModes[key]; this.schedule() }
  queuedEntries(): [string, PersistedInbound[]][] { return Object.entries(this.state.queuedMessages) }
  // Очередь пишем СРАЗУ, без обычной задержки в 300 мс: она и существует ради «не потерять
  // сообщение при рестарте», а внутри окна задержки рестарт теряет ровно то, что положили.
  setQueued(key: string, v: PersistedInbound[]): void { this.state.queuedMessages[key] = v; this.flush() }
  delQueued(key: string): void { delete this.state.queuedMessages[key]; this.flush() }
  launchCaptureEntries(): [string, PersistedLaunchCapture][] { return Object.entries(this.state.launchCaptures) }
  setLaunchCapture(key: string, v: PersistedLaunchCapture): void { this.state.launchCaptures[key] = v; this.schedule() }
  delLaunchCapture(key: string): void { delete this.state.launchCaptures[key]; this.schedule() }
  interactionSnapshot(): Record<string, unknown> { return this.state.interactions }
  replaceInteractions(value: Record<string, PersistedInteraction>): void { this.state.interactions = value; this.schedule() }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, 300)
  }

  // Write now (used on shutdown; also runs from the debounce timer). Atomic via tmp→rename.
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      writeFileSync(this.tmp, JSON.stringify(this.state), { mode: 0o600 })
      renameSync(this.tmp, this.file)
    } catch (e) {
      this.log(`hub-state flush failed: ${e}`)
    }
  }
}
