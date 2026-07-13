# telegram-tmux-channels — a Telegram channel for Claude Code with topic bindings

One Telegram bot drives **many Claude Code sessions** (hub-and-spoke). A forum topic
or a DM binds to a project folder with `/bind` right from Telegram; the session replies
strictly into its own topic. Unlike mirrors such as ccgram, **not the whole transcript**
goes to chat — only what the agent sends via the reply tool (native Claude Code channels).
Cross-platform: **Linux and macOS**.

Beyond plain messaging: the CLI's own interactive prompts (`AskUserQuestion`, `/model`) show
up as real Telegram inline-keyboard buttons; incoming voice notes are transcribed and replies
can be spoken back; running subagents, the todo list, and skill calls each get a self-updating
status message.

A fork of the official `telegram@claude-plugins-official`.

## Architecture

- **Hub** `src/hub.ts` — the sole owner of the token and the getUpdates poller. Routing:
  chat key (`chatId/topicId`, `chatId`, `dm:userId`) → `bindings.json` → project folder
  → live sessions with that cwd. Unix socket `~/.claude/channels/telegram/hub.sock`; tmux
  ops; permission buttons for admins. **Starts itself** (autospawned from the first stub) —
  no service manager required.
- **Stub** `src/stub.ts` — a per-session MCP pipe: reports the session's folder/pane/pid/argv
  to the hub, relays events and RPCs (`reply`/`react`/`edit_message`/`download_attachment`).
  If the socket is absent it autospawns the hub (detached, survives the session; Linux and macOS).
- **Picker bridge** (`src/picker.ts`, wired into the hub's `pollScreens` loop) — screen-scrapes
  each live pane at a fixed interval; any TUI prompt it recognizes (`AskUserQuestion`, `/model`)
  becomes a Telegram message with inline-keyboard buttons, and a tap is replayed as real
  keystrokes into the pane. No MCP permission-prompt hook involved — it's a tmux screen diff.
- **Status messages** (`hooks/hooks.json` → `src/subagent-hook.ts` → hub) — one self-editing
  Telegram message per binding per turn for: running subagents (🤖 Агенты), the `TaskCreate`/
  `TaskUpdate` todo list (📋 Задачи), and `Skill` tool calls. Finished items keep a ✅ rather
  than disappearing — the message is the turn's history, not just a live snapshot.
- State lives in `~/.claude/channels/telegram/`: `.env` (token + `TELEGRAM_ADMINS`, not in git),
  `bindings.json` (hub-managed, hot-reloaded).

## Requirements

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).
- tmux (for the tmux ops `/compact`/`/restart`/`/new`; without it the channel still works, ops don't).
- A Telegram bot from @BotFather. In a group: privacy mode **off**, topics **on**, bot is a member.

## Install (Linux / macOS)

```
/plugin marketplace add <git-url of this marketplace>
/plugin install telegram-tmux-channels@<marketplace>
/telegram:configure <bot-token>        # registers the stub, saves the token, asks for admin ids
```

The `configure` skill locates the plugin path, runs `claude mcp add --scope user`, and writes
`.env`. Then launch a session inside a project folder:

```
claude --dangerously-load-development-channels server:telegram
```

(The dev flag is mandatory: third-party channels aren't on Claude Code's approved allowlist —
a platform limitation, not a plugin one.) The hub autospawns on the first stub connection.

## Access

- **Admins** (`TELEGRAM_ADMINS` in `.env`) — converse with every binding, receive permission
  buttons, and are the only ones who may `/bind`, `/unbind`, `/allow`.
- **Extra users** — `/allow <id>` in a topic: conversation and tmux ops for that binding only.
  Empty allow = admins only. Remove by editing `bindings.json`.

## Chat commands (not forwarded into the session)

- `/bind <folder>` — bind this topic/DM to a folder (name under `$TELEGRAM_PROJECTS_DIR`,
  default `~/projects`, or an absolute path/`~/…`); `/unbind` also kills the tmux session the
  hub created for this binding (in `worktree` mode, after any configured delete hook runs);
  `/allow <id …>`.
- **Trusted groups** — a group can be configured (`trusted-groups.json`) to auto-bind any new
  forum topic without `/bind`, in `folder` mode (shared project dir) or `worktree` mode (its
  own git worktree + branch per topic, with a `{create, delete}` shell-command hook, e.g.
  `wt.py`). Cyrillic topic names get transliterated before becoming a branch/tmux-session name.
- `/status` — folder + git branch, tmux session name, claude session id, whether claude is
  alive, 5h/7d limits and context fill.
- `/resume` — bring a session up (`--continue`); `/new` — a fresh one; the hub creates the
  tmux session (named after the folder) and clicks through the startup prompts (folder trust,
  dev warning).
- `/compact`, `/clear`, `/esc`, `/restart`, `/stop` (graceful, no relaunch) — for a live session.
- `/model` — opens the CLI's model picker as Telegram buttons (via the picker bridge).
- `/screen` — PNG snapshot of the live pane (headless-chrome render of the ANSI capture) —
  escape hatch for any TUI state the picker bridge doesn't recognize.
- Won't start a second session if claude is already running in the folder (so `--continue`
  doesn't fork a foreign conversation).
- An unexpected death (tmux/process gone without an explicit `/restart`) gets a 💀 notice after
  a grace period, rather than silently going quiet.

## Config (env in `~/.claude/channels/telegram/.env`)

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | bot token (required) |
| `TELEGRAM_ADMINS` | — | admin ids, comma-separated |
| `TELEGRAM_PROJECTS_DIR` | `$HOME/projects` | base for `/bind <name>` |
| `TELEGRAM_LAUNCH_CMD` | `claude --permission-mode bypassPermissions` | base launch for `/new`,`/resume` (channel flags appended automatically) |
| `TELEGRAM_HUB_AUTOSPAWN` | `1` | `0` disables autospawn (for a service-only install) |
| `OPENAI_API_KEY` | — | enables voice (STT + TTS); unset = voice silently disabled |
| `STT_OPENAI_MODEL` | `gpt-4o-transcribe` | transcription model for incoming voice notes |
| `STT_OPENAI_BASE_URL` | `https://api.openai.com/v1` | override for an OpenAI-compatible endpoint |
| `TTS_OPENAI_MODEL` | `gpt-4o-mini-tts` | speech model for `reply(..., voice: true)` |
| `TTS_OPENAI_VOICE` | `onyx` | TTS voice |
| `TTS_OPENAI_BASE_URL` | `https://api.openai.com/v1` | override for an OpenAI-compatible endpoint |

## Voice

Incoming Telegram voice notes are auto-transcribed (their text stands in for the message).
The `reply` tool takes an optional `voice: true` to also send the text as a spoken voice note.
Both go straight to OpenAI's audio endpoints (no ffmpeg — Telegram's `.oga` is a plain
Ogg/Opus container, byte-compatible with what the TTS endpoint returns and what `sendVoice`
expects).

## Optional always-on hub

Autospawn keeps the hub up only while at least one session exists. To have the bot answer
with no sessions running, install a service from `examples/` (`telegram-hub.service` for
systemd, `dev.windbit.claude-telegram.plist` for launchd), filling in the absolute paths.
"Service wins" comes for free: while it holds the socket, stubs connect instead of spawning.
