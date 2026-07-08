import { rmSync } from 'fs'

export function rmQuiet(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {} // best-effort cleanup
}

export function safeJsonParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch (e) {
    if (e instanceof SyntaxError) {
      return undefined
    }
    throw e
  }
}
