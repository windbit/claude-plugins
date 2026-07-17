#!/usr/bin/env bash
# Turnkey seeding for the clod-tmux test container: a fresh Claude Code home hits several
# first-run gates (theme, folder-trust) and doesn't know about the hub's stub MCP or the
# plugin hooks — none of which exist in a bind-mounted-source dev setup. Seed them once so
# hub-spawned sessions start clean and fire status hooks. Idempotent; runs on every start.
# Auth itself comes from CLAUDE_CODE_OAUTH_TOKEN in the env (docker.env), NOT a shared creds
# file — see docker-compose.yml.
set -e
PLUGDIR=/home/user/claude-plugins/telegram-tmux-channels
BUN=/home/user/.bun/bin/bun
mkdir -p ~/.claude/channels/telegram ~/projects

python3 - "$PLUGDIR" "$BUN" <<'PY'
import json, os, sys, glob
plugdir, bun = sys.argv[1], sys.argv[2]
home = os.path.expanduser("~")

# 1) ~/.claude.json: skip onboarding, register the stub MCP, pre-trust project dirs
p = os.path.join(home, ".claude.json")
d = json.load(open(p)) if os.path.exists(p) else {}
d.update({"hasCompletedOnboarding": True, "lastOnboardingVersion": "2.1.212",
          "theme": "dark", "installMethod": "native", "autoUpdates": False})
d.setdefault("mcpServers", {})["telegram"] = {
    "type": "stdio", "command": bun,
    "args": ["run", f"{plugdir}/src/stub.ts"], "env": {}}
projects = d.setdefault("projects", {})
for proj in glob.glob(f"{home}/projects/*") + [f"{home}/projects"]:
    projects.setdefault(proj, {})["hasTrustDialogAccepted"] = True
json.dump(d, open(p, "w"), indent=2)

# 2) ~/.claude/settings.json: wire the plugin hooks (abs paths — no plugin install here)
hooks = json.load(open(f"{plugdir}/hooks/hooks.json"))["hooks"]
for arr in hooks.values():
    for entry in arr:
        for h in entry.get("hooks", []):
            if h.get("type") == "command":
                c = h["command"].replace("${CLAUDE_PLUGIN_ROOT}", plugdir)
                if c.startswith("bun "):
                    c = bun + c[3:]
                h["command"] = c
sp = os.path.join(home, ".claude", "settings.json")
s = json.load(open(sp)) if os.path.exists(sp) else {}
s["hooks"] = hooks
json.dump(s, open(sp, "w"), indent=2)
print("clod-tmux seeded: onboarding + stub MCP + hooks + trust")
PY

# Note: `--permission-mode bypassPermissions` still shows a one-time "accept" prompt per
# session that has no config toggle; the hub's ackStartupPrompts only presses Enter (which
# would pick "No"). Until that's handled hub-side, accept it once via the pane if a spawned
# session stalls on it.

exec "${@:-sleep infinity}"
