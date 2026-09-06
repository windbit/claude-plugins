// Кроны сессии умирают вместе с ней, поэтому по ним хаб решает не гасить топик. Данные
// приходят из payload Stop-хука (проверено на живом: `session_crons` там есть и заполнен).
import { describe, expect, test } from 'bun:test'
import { parseSessionCrons, nextCronFire, cronHold, CRON_MARK_STALE_MS } from '../src/session-crons'

const cron = (schedule: string, recurring = true) => ({ id: 'a1', schedule, recurring })
// среда, 7 сентября 2026, 09:00 местного времени
const WED = new Date(2026, 8, 7, 9, 0, 0, 0).getTime()
const MIN = 60_000
const HOUR = 60 * MIN

describe('разбор session_crons', () => {
  test('берём только записи с id и расписанием', () => {
    expect(parseSessionCrons([
      { id: 'a8cde360', schedule: '7 * * * *', recurring: true, prompt: 'смотри логи' },
      { id: '', schedule: '* * * * *' },
      { schedule: '* * * * *' },
      'мусор',
    ])).toEqual([{ id: 'a8cde360', schedule: '7 * * * *', recurring: true, prompt: 'смотри логи' }])
  })

  test('не массив — пусто, а не падение', () => {
    expect(parseSessionCrons(undefined)).toEqual([])
    expect(parseSessionCrons({ id: 'a1' })).toEqual([])
  })
})

describe('ближайшее срабатывание', () => {
  test('ежечасный в :07 — через 7 минут', () => {
    expect(nextCronFire('7 * * * *', WED)).toBe(WED + 7 * MIN)
  })

  test('одноразовый на утро 7 сентября 10:23 — через час с небольшим', () => {
    expect(nextCronFire('23 10 7 9 *', WED)).toBe(WED + HOUR + 23 * MIN)
  })

  test('за горизонтом — не находим (нам и не надо)', () => {
    expect(nextCronFire('0 9 1 1 *', WED)).toBeUndefined() // 1 января
  })

  test('шаги и списки понимаем', () => {
    expect(nextCronFire('*/15 * * * *', WED)).toBe(WED + 15 * MIN)
    expect(nextCronFire('30,45 9 * * *', WED)).toBe(WED + 30 * MIN)
  })

  test('невнятное расписание — undefined, а не выдумка', () => {
    expect(nextCronFire('каждый час', WED)).toBeUndefined()
    expect(nextCronFire('7 * * *', WED)).toBeUndefined() // четыре поля
    expect(nextCronFire('99 * * * *', WED)).toBeUndefined() // минута вне диапазона
  })
})

describe('решение держать сессию', () => {
  test('живой крон в пределах горизонта — держим и говорим какой', () => {
    const out = cronHold([cron('7 * * * *')], WED, WED)
    expect(out.held).toBe(true)
    expect(out.held && out.at).toBe(WED + 7 * MIN)
  })

  test('кронов нет — не держим', () => {
    expect(cronHold([], WED, WED).held).toBe(false)
  })

  test('срабатывание дальше 12 часов — не держим', () => {
    expect(cronHold([cron('0 9 1 1 *')], WED, WED).held).toBe(false)
  })

  test('метка протухла (сессия молчит сутки) — не держим', () => {
    expect(cronHold([cron('7 * * * *')], WED, WED + CRON_MARK_STALE_MS).held).toBe(false)
  })

  test('из нескольких кронов берём ближайший', () => {
    const out = cronHold([cron('0 20 * * *'), cron('30 9 * * *')], WED, WED)
    expect(out.held && out.at).toBe(WED + 30 * MIN)
  })
})
