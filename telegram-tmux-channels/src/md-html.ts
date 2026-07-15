// Обычный Markdown (как его пишут агенты) → подмножество HTML, которое понимает Telegram.
// Зачем HTML, а не MarkdownV2: у HTML экранируется только &<>, он не роняет сообщение на
// неэкранированном спецсимволе. Telegram HTML знает лишь b/i/s/u/code/pre/a/blockquote —
// заголовки/списки конвертим в жирный/буллеты (своих тегов у них в телеге нет).

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function mdToHtml(src: string): string {
  // 1. вынимаем код (сначала блоки ```…```, потом инлайн `…`) в плейсхолдеры — внутри него
  //    markdown НЕ трактуем, только эскейпим при вставке обратно.
  const codes: { pre: boolean; body: string }[] = []
  const stash = (pre: boolean, body: string) => `\x00${codes.push({ pre, body }) - 1}\x00`
  let s = src
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, b) => stash(true, b.replace(/\n$/, '')))
    .replace(/`([^`\n]+)`/g, (_m, b) => stash(false, b))

  // 2. эскейпим HTML в оставшемся тексте
  s = esc(s)

  // 3. markdown → HTML (порядок важен)
  // &<> в url уже эскейпнуты шагом 2 — здесь добиваем только кавычку для атрибута
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')            // заголовки → жирный
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1• ')                  // буллеты (до italic — снимает ведущую *)
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/__(.+?)__/g, '<b>$1</b>')
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>')
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>')
  s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g, '$1<i>$2</i>')

  // 4. возвращаем код (эскейпим тело, но не markdown)
  s = s.replace(/\x00(\d+)\x00/g, (_m, i) => {
    const c = codes[Number(i)]
    return c.pre ? `<pre>${esc(c.body)}</pre>` : `<code>${esc(c.body)}</code>`
  })
  return s
}
