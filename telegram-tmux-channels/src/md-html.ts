// Plain Markdown (as agents write it) → the HTML subset Telegram understands.
// Why HTML, not MarkdownV2: HTML only escapes &<>, so it never drops a message on an
// unescaped special char. Telegram HTML knows only b/i/s/u/code/pre/a/blockquote —
// headings/lists become bold/bullets (Telegram has no tags of its own for them).

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function mdToHtml(src: string): string {
  // 1. pull code out (fenced ```…``` first, then inline `…`) into placeholders — inside it
  //    markdown is NOT interpreted, only escaped when spliced back.
  const codes: { pre: boolean; body: string }[] = []
  const stash = (pre: boolean, body: string) => `\x00${codes.push({ pre, body }) - 1}\x00`
  let s = src
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, b) => stash(true, b.replace(/\n$/, '')))
    .replace(/`([^`\n]+)`/g, (_m, b) => stash(false, b))

  // 2. escape HTML in the remaining text
  s = esc(s)

  // 3. markdown → HTML (order matters)
  // &<> in the url were already escaped by step 2 — here we only finish off the attribute quote
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')            // headings → bold
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1• ')                  // bullets (before italic — strips the leading *)
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/__(.+?)__/g, '<b>$1</b>')
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>')
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>')
  s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g, '$1<i>$2</i>')

  // 4. restore code (escape the body, but not markdown)
  s = s.replace(/\x00(\d+)\x00/g, (_m, i) => {
    const c = codes[Number(i)]
    return c.pre ? `<pre>${esc(c.body)}</pre>` : `<code>${esc(c.body)}</code>`
  })
  return s
}
