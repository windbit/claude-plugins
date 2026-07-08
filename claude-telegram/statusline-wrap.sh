#!/usr/bin/env bash
# Обёртка statusline: дампит stdin-JSON (лимиты 5h/7d, контекст) для telegram-хаба
# (/status в чате) и передаёт его нетронутым в настоящий statusline-скрипт.
# Подключение в ~/.claude/settings.json:
#   "statusLine": { "type": "command",
#     "command": "~/projects/homelab/apps/claude-telegram/statusline-wrap.sh ~/.claude/statusline.sh" }
input=$(cat)

dir="$HOME/.claude/channels/telegram/limits"
slug=$(printf '%s' "$input" | jq -r '.cwd // empty' | tr '/' '-')
if [ -n "$slug" ]; then
  mkdir -p "$dir"
  printf '%s' "$input" > "$dir/$slug.json.tmp" && mv "$dir/$slug.json.tmp" "$dir/$slug.json"
fi

if [ "$#" -gt 0 ] && [ -x "$1" ]; then
  printf '%s' "$input" | "$@"
fi
