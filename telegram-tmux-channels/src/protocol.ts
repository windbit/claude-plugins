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
