// Кроны и лупы живут ТОЛЬКО в сессии: погасили её по простою — расписание умерло вместе с ней,
// и обещанная утренняя проверка просто не случится. Хаб узнаёт о них бесплатно: Claude Code
// кладёт `session_crons` в payload Stop-хука, а тот и так приходит на каждом конце хода.

/** Крон сессии, как его отдаёт хук: пятиполевое cron-выражение в ЛОКАЛЬНОМ времени. */
export type SessionCron = { id: string; schedule: string; recurring: boolean; prompt?: string }

/** Дальше этого срока держать сессию не за что: разбудит её не крон, а человек. */
export const CRON_HOLD_HORIZON_MS = 12 * 60 * 60_000
/** Сессия молчит дольше — считаем метку протухшей: сама сессия могла уже умереть. */
export const CRON_MARK_STALE_MS = 24 * 60 * 60_000

export function parseSessionCrons(value: unknown): SessionCron[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap(raw => {
    if (!raw || typeof raw !== 'object') {
      return []
    }
    const { id, schedule, recurring, prompt } = raw as Record<string, unknown>
    if (typeof id !== 'string' || typeof schedule !== 'string' || !id || !schedule) {
      return []
    }
    return [{
      id, schedule, recurring: recurring === true,
      ...(typeof prompt === 'string' ? { prompt } : {}),
    }]
  })
}

const FIELD_RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]

/** Поле cron → множество допустимых значений. undefined = выражение нам не по зубам. */
function fieldValues(field: string, [min, max]: [number, number]): Set<number> | undefined {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) {
      return undefined
    }
    let from = min
    let to = max
    if (range !== '*' && range !== undefined) {
      const bounds = range.split('-').map(Number)
      if (bounds.some(n => !Number.isInteger(n))) {
        return undefined
      }
      from = bounds[0]!
      to = bounds.length > 1 ? bounds[1]! : bounds[0]!
    }
    if (from < min || to > max || from > to) {
      return undefined
    }
    for (let v = from; v <= to; v += step) {
      out.add(v)
    }
  }
  return out.size ? out : undefined
}

/** Ближайшее срабатывание в миллисекундах, undefined — не разобрали или его нет впереди.
 *
 *  Считаем в местном времени: расписание задаётся в нём же. Перебор по минутам ограничен
 *  горизонтом — дальше него ответ всё равно не нужен, а искать «когда-нибудь в мае» дорого. */
export function nextCronFire(schedule: string, from: number, horizonMs = CRON_HOLD_HORIZON_MS): number | undefined {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) {
    return undefined
  }
  const sets = fields.map((f, i) => fieldValues(f, FIELD_RANGES[i]!))
  if (sets.some(s => !s)) {
    return undefined
  }
  const [minutes, hours, days, months, weekdays] = sets as Set<number>[]
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1) // текущая минута уже прошла
  for (let end = from + horizonMs; cursor.getTime() <= end; cursor.setMinutes(cursor.getMinutes() + 1)) {
    if (
      minutes!.has(cursor.getMinutes()) && hours!.has(cursor.getHours()) &&
      months!.has(cursor.getMonth() + 1) &&
      // В cron день месяца и день недели — ИЛИ, если задан хотя бы один из них.
      (days!.has(cursor.getDate()) || weekdays!.has(cursor.getDay()))
    ) {
      return cursor.getTime()
    }
  }
  return undefined
}

/** Держать ли сессию из-за её кронов — и почему. */
export function cronHold(
  crons: SessionCron[], seenAt: number, now: number,
): { held: false } | { held: true; at: number; cron: SessionCron } {
  if (!crons.length || now - seenAt >= CRON_MARK_STALE_MS) {
    return { held: false }
  }
  let soonest: { at: number; cron: SessionCron } | undefined
  for (const cron of crons) {
    const at = nextCronFire(cron.schedule, now)
    if (at != null && (!soonest || at < soonest.at)) {
      soonest = { at, cron }
    }
  }
  return soonest ? { held: true, ...soonest } : { held: false }
}
