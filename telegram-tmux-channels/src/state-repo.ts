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

const STATE_FILE = join(STATE_DIR, 'hub-state.json')
const TMP_FILE = `${STATE_FILE}.tmp`

type PendingAnswer = { dir: string; at: number }
export type HubState = {
  version: 1
  pendingAnswer: Record<string, PendingAnswer>
  lastFallback: Record<string, string>
}

const empty = (): HubState => ({ version: 1, pendingAnswer: {}, lastFallback: {} })

export class HubStateRepository {
  private state: HubState = empty()
  private timer: ReturnType<typeof setTimeout> | null = null
  private log: (s: string) => void

  constructor(log: (s: string) => void = () => {}) {
    this.log = log
    try {
      const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<HubState>
      if (raw && raw.version === 1) {
        this.state = { ...empty(), ...raw, pendingAnswer: raw.pendingAnswer ?? {}, lastFallback: raw.lastFallback ?? {} }
      }
    } catch {} // no file / corrupt → start empty
  }

  // hydrate live Maps on boot
  pendingEntries(): [string, PendingAnswer][] { return Object.entries(this.state.pendingAnswer) }
  fallbackEntries(): [string, string][] { return Object.entries(this.state.lastFallback) }

  setPending(key: string, v: PendingAnswer): void { this.state.pendingAnswer[key] = v; this.schedule() }
  delPending(key: string): void { delete this.state.pendingAnswer[key]; this.schedule() }
  setFallback(key: string, text: string): void { this.state.lastFallback[key] = text; this.schedule() }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, 300)
  }

  // Write now (used on shutdown; also runs from the debounce timer). Atomic via tmp→rename.
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    try {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
      writeFileSync(TMP_FILE, JSON.stringify(this.state), { mode: 0o600 })
      renameSync(TMP_FILE, STATE_FILE)
    } catch (e) {
      this.log(`hub-state flush failed: ${e}`)
    }
  }
}
