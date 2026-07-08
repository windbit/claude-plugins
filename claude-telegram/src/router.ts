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

  byDir(dir: string): C[] {
    const out: C[] = []
    for (const [conn, s] of this.subs) {
      if (s.cwd === dir) {
        out.push(conn)
      }
    }
    return out
  }

  size(): number {
    return this.subs.size
  }
}
