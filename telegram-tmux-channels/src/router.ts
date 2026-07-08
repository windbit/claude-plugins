import type { SessionInfo } from './protocol'

// Live sessions; a session's identity is its directory (session.cwd).
export class Router<C> {
  private subs = new Map<C, SessionInfo>()

  subscribe(conn: C, session: SessionInfo): void {
    this.subs.set(conn, session)
  }

  unsubscribe(conn: C): void {
    this.subs.delete(conn)
  }

  get(conn: C): SessionInfo | undefined {
    return this.subs.get(conn)
  }

  all(): C[] {
    return [...this.subs.keys()]
  }

  byDir(dir: string): C[] {
    const out: C[] = []
    for (const [conn, s] of this.subs) {
      if (s.cwd === dir) {
        out.push(conn)
      }
    }
    return out
  }

  byBindingKey(key: string): C[] {
    const out: C[] = []
    for (const [conn, s] of this.subs) {
      if (s.bindingKeys?.includes(key)) {
        out.push(conn)
      }
    }
    return out
  }

  size(): number {
    return this.subs.size
  }
}
