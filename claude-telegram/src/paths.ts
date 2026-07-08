import { homedir } from 'os'
import { join } from 'path'

export const STATE_DIR =
  process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
// Same name as the upstream plugin: hub startup SIGTERMs its zombie poller.
export const PID_FILE = join(STATE_DIR, 'bot.pid')
export const SOCK_PATH = join(STATE_DIR, 'hub.sock')
