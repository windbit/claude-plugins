// Atomic file-backed persistence for hub state that must survive a restart. Today: the
// reply-fallback "awaiting an answer" markers (a hub restart between an inbound message and the
// agent's reply used to wipe them, so the fallback never fired — the bug this fixes). Pickers,
// permissions and status-message refs plug into the same store next.
//
// One JSON snapshot under STATE_DIR, written tmp→rename so a crash mid-write can't leave a
// half-file, debounced so a burst of updates doesn't thrash the disk. In-memory maps stay the
// source of truth at runtime; this only mirrors them to disk and reloads on boot.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { STATE_DIR } from './paths'
import { join } from 'path'
import type { Picker } from './picker'

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
}

const empty = (): HubState => ({ version: 1, pendingAnswer: {}, lastFallback: {}, pickers: {} })

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

  pickerEntries(): [string, PersistedPicker][] { return Object.entries(this.state.pickers) }
  setPicker(pane: string, v: PersistedPicker): void { this.state.pickers[pane] = v; this.schedule() }
  delPicker(pane: string): void { delete this.state.pickers[pane]; this.schedule() }

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
