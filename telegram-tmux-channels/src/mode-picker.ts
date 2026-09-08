// Раскладка пикера режима для нового топика. Вынесено из хаба ЧИСТОЙ функцией: логика тут
// комбинаторная (режимы × базы × харнесс × хук), а такая логика тихо разрастается — на хук
// когда-то завели вторую кнопку на каждую базу, и пикер удвоился в рядах.
import { modeLabel, type TrustedGroupMode } from './trusted-groups'
import { t } from './i18n'

export type ModeButton = { text: string; data: string }

export type ModePickerOpts = {
  key: string
  modes: TrustedGroupMode[]
  /** Базы для ворктри; больше одной — кнопка «worktree» размножается по базам. */
  bases: string[]
  /** У проекта есть create-хук: только тогда переключатель «со стендом / без» имеет смысл. */
  hooked: boolean
  /** Положение переключателя: true — резать голый ворктри, без хука проекта. */
  hookOff: boolean
  /** Подпись текущего харнесса; пусто — переключателя харнесса нет. */
  harness?: string
}

/** Кнопки пикера, по одной на ряд. Переключатели идут первыми: они меняют смысл кнопок ниже. */
export function modeButtons(opts: ModePickerOpts): ModeButton[] {
  const { key, modes, bases, hooked, hookOff, harness } = opts
  const rows: ModeButton[] = []
  if (harness) {
    rows.push({ text: t().harnessToggle(harness), data: `topicharness:${key}` })
  }
  if (hooked) {
    rows.push({ text: t().hookToggle(!hookOff), data: `topichook:${key}` })
  }
  const worktreeMode: TrustedGroupMode = hooked && hookOff ? 'worktree-plain' : 'worktree'
  for (const mode of modes) {
    if (mode !== 'worktree') {
      rows.push({ text: modeLabel(mode), data: `topicmode:${key}:${mode}` })
      continue
    }
    // Выбор режима и выбор базы — один вопрос, один тап: отдельного пикера баз не заводим.
    if (bases.length > 1) {
      bases.forEach((base, i) => rows.push({
        text: t().modeWorktreeFrom(base),
        data: `topicmode:${key}:${worktreeMode}:${i}`,
      }))
      continue
    }
    rows.push({ text: modeLabel(worktreeMode), data: `topicmode:${key}:${worktreeMode}` })
  }
  rows.push({ text: t().ownDirLabel, data: `topicdir:${key}` })
  return rows
}
