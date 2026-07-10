# CLAUDE.md

Dev conventions for this plugin's code (not user-facing — see README.md for that).

## Telegram message formatting (hub.ts)

A message with a bold header line gets a blank line after it, before the body:
`🤖 <b>Заголовок</b>\n\n<остальное>`, not `\n<остальное>` directly. Applies whenever the
header is its own line — not inline emphasis like `📁 <b>Foo</b> — bar`.
