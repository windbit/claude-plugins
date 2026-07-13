// ANSI (tmux capture-pane -e) → HTML для PNG-рендера /screen через headless chrome.
// Только SGR-коды (цвет/жирность/инверсия); остальные escape-последовательности срезаются.

const BASE16 = [
  '#1e1e1e', '#f44747', '#6a9955', '#d7ba7d', '#569cd6', '#c586c0', '#4ec9b0', '#d4d4d4',
  '#808080', '#f44747', '#6a9955', '#d7ba7d', '#569cd6', '#c586c0', '#4ec9b0', '#ffffff',
]

function color256(n: number): string {
  if (n < 16) {
    return BASE16[n]
  }
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255]
    const i = n - 16
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`
  }
  const g = 8 + 10 * (n - 232)
  return `rgb(${g},${g},${g})`
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Sgr = { fg?: string; bg?: string; bold?: boolean; reverse?: boolean }

// один span на отрезок с одинаковым стилем
function span(text: string, st: Sgr): string {
  if (!text) {
    return ''
  }
  let { fg, bg } = st
  if (st.reverse) {
    ;[fg, bg] = [bg ?? '#d4d4d4', fg ?? '#1e1e1e']
  }
  const css = [fg && `color:${fg}`, bg && `background:${bg}`, st.bold && 'font-weight:bold'].filter(Boolean).join(';')
  return css ? `<span style="${css}">${escHtml(text)}</span>` : escHtml(text)
}

export function ansiToHtml(ansi: string): string {
  // не-SGR escape-последовательности (OSC, курсор и т.п.) — вон
  const clean = ansi.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-lnzA-Z]|\x1b[^[\]]/g, '')
  let st: Sgr = {}
  let out = ''
  let last = 0
  for (const m of clean.matchAll(/\x1b\[([0-9;]*)m/g)) {
    out += span(clean.slice(last, m.index), st)
    last = m.index! + m[0].length
    const codes = (m[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0) {
        st = {}
      } else if (c === 1) {
        st.bold = true
      } else if (c === 7) {
        st.reverse = true
      } else if (c === 22) {
        st.bold = false
      } else if (c === 27) {
        st.reverse = false
      } else if (c >= 30 && c <= 37) {
        st.fg = BASE16[c - 30]
      } else if (c >= 90 && c <= 97) {
        st.fg = BASE16[c - 90 + 8]
      } else if (c === 39) {
        st.fg = undefined
      } else if (c >= 40 && c <= 47) {
        st.bg = BASE16[c - 40]
      } else if (c >= 100 && c <= 107) {
        st.bg = BASE16[c - 100 + 8]
      } else if (c === 49) {
        st.bg = undefined
      } else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const col = color256(codes[i + 2] ?? 0)
        c === 38 ? (st.fg = col) : (st.bg = col)
        i += 2
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`
        c === 38 ? (st.fg = col) : (st.bg = col)
        i += 4
      }
    }
  }
  out += span(clean.slice(last), st)
  return (
    '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#1e1e1e">' +
    '<pre style="margin:0;padding:12px;font:14px/19px \'DejaVu Sans Mono\',monospace;color:#d4d4d4">' +
    out +
    '</pre>'
  )
}
