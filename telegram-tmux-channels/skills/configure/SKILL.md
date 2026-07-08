---
name: configure
description: Set up the Telegram channel — register the MCP stub, save the bot token and admin ids. Use when the user pastes a Telegram bot token, asks to configure Telegram, or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(claude mcp *)
  - Bash(systemctl --user *)
  - Bash(launchctl *)
---

# /telegram:configure — Telegram Channel Setup

Cross-platform (Linux + macOS). State lives in `~/.claude/channels/telegram/`:

- `.env` — `TELEGRAM_BOT_TOKEN` (from @BotFather) + `TELEGRAM_ADMINS`
  (comma-separated Telegram user ids: admins converse everywhere, get permission
  buttons, and may /bind,/unbind,/allow,/new). Optional: `TELEGRAM_PROJECTS_DIR`
  (base for `/bind <name>`, default `$HOME/projects`), `TELEGRAM_LAUNCH_CMD`
  (base launch command for /new,/resume, default `claude --permission-mode
  bypassPermissions`; channel flags are appended automatically).
- `bindings.json` — chat/topic → project dir map, managed hub-side via /bind in
  Telegram. Editable by hand (hot-reloaded).

Arguments passed: `$ARGUMENTS`

## No args — status

Read `.env` (mask the token to first 10 chars) and `bindings.json`; show token
set/not-set, admins, and current bindings. Check the MCP stub is registered:
`claude mcp list | grep telegram`. Guide to the next missing step.

## First-time setup

1. **Locate the plugin** (for the stub path):
   `ls -d ~/.claude/plugins/cache/*/telegram-tmux-channels/*/src/stub.ts | tail -1`
2. **Register the stub globally** so every session can reach Telegram:
   `claude mcp add --scope user telegram -- bun run <that stub.ts path>`
   (bun must be installed: https://bun.sh)
3. **Token**: validate shape `/^\d+:[\w-]+$/`; `mkdir -p
   ~/.claude/channels/telegram`; merge `TELEGRAM_BOT_TOKEN=<token>` into `.env`
   (keep other lines); `chmod 600` the file.
4. **Admins**: ask for the user's Telegram id (via @userinfobot) and write
   `TELEGRAM_ADMINS=<id>` into `.env`.
5. **Launch a session** in a project: `claude --dangerously-load-development-channels
   server:telegram` (the hub autospawns on first stub connect — no service needed).
6. **Bind** from Telegram: in the target chat/topic an admin sends `/bind <folder>`.

## Optional always-on hub

By default the hub autospawns from the first session's stub. To keep the bot
answering with **no** sessions running, install the service from `examples/`:
- Linux: `examples/telegram-hub.service` (systemd user unit)
- macOS: `examples/dev.windbit.claude-telegram.plist` (launchd LaunchAgent)
Fill the absolute paths shown inside, then enable. "Service wins" automatically:
when it holds the socket, stubs connect instead of spawning.

## Notes

- One token = one poller: never run two hubs on the same bot.
- Token change → restart the hub (`systemctl --user restart telegram-hub`,
  `launchctl kickstart -k ...`, or just kill it — a session will respawn it).
