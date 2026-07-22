export const MAX_CHUNK_LIMIT = 4096
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export const CAPTION_LIMIT = 1024 // Telegram caps photo/album captions here; messages get 4096
export const ALBUM_MAX = 10 // sendMediaGroup accepts 2..10 items

export type AttachmentPlan = {
  /** photo batches — each of 2+ goes out as one album, a lone one as a plain photo */
  photos: string[][]
  /** everything else, sent one by one */
  docs: string[]
  /** put the text on the first attachment instead of sending it as its own message */
  caption: boolean
}

/**
 * Decide how files ride along with the text. Caption keeps text and image in ONE message and
 * is the only way to title an album — but only if the text actually fits Telegram's cap and
 * didn't have to be split, otherwise it stays a separate message (as it always did).
 */
export function planAttachments(files: string[], chunks: string[]): AttachmentPlan {
  const photos: string[] = []
  const docs: string[] = []
  for (const f of files) {
    const dot = f.lastIndexOf('.')
    const ext = dot === -1 ? '' : f.slice(dot).toLowerCase()
    ;(PHOTO_EXTS.has(ext) ? photos : docs).push(f)
  }
  const batches: string[][] = []
  for (let i = 0; i < photos.length; i += ALBUM_MAX) {
    batches.push(photos.slice(i, i + ALBUM_MAX))
  }
  return {
    photos: batches,
    docs,
    caption: files.length > 0 && chunks.length === 1 && (chunks[0]?.length ?? 0) <= CAPTION_LIMIT,
  }
}

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) {
    return [text]
  }
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) {
    out.push(rest)
  }
  return out
}
