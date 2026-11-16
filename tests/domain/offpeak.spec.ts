import { describe, expect, it } from 'vitest'
import { CN_HOLIDAY_YEARS, CN_WEEKDAY_OFF_DAYS } from '../../src/domain/holidays-cn.ts'
import {
  DEEPSEEK_SCHEDULE, isOffPeakTarget, LONG_WINDOW_MS, offPeakSnoozeTargets, pricingAt, type OffPeakSchedule,
} from '../../src/domain/offpeak.ts'
import { HOUR_MS } from '../../src/domain/time.ts'

/** UTC instant on a 'YYYY-MM-DD' date. */
const at = (date: string, hour: number, minute = 0, second = 0, ms = 0): number => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d, hour, minute, second, ms)
}

const MONDAY = '2026-11-16'
const TUESDAY = '2026-11-17'

describe('pricingAt', () => {
  it.each([
    ['00:59:59.999', at(MONDAY, 0, 59, 59, 999), { phase: 'off-peak', peakAt: at(MONDAY, 1) }],
    ['01:00', at(MONDAY, 1), { phase: 'peak', offPeakAt: at(MONDAY, 4) }],
    ['03:59:59.999', at(MONDAY, 3, 59, 59, 999), { phase: 'peak', offPeakAt: at(MONDAY, 4) }],
    ['04:00', at(MONDAY, 4), { phase: 'off-peak', peakAt: at(MONDAY, 6) }],
    ['05:59', at(MONDAY, 5, 59), { phase: 'off-peak', peakAt: at(MONDAY, 6) }],
    ['06:00', at(MONDAY, 6), { phase: 'peak', offPeakAt: at(MONDAY, 10) }],
    ['09:59:59.999', at(MONDAY, 9, 59, 59, 999), { phase: 'peak', offPeakAt: at(MONDAY, 10) }],
    ['10:00', at(MONDAY, 10), { phase: 'off-peak', peakAt: at(TUESDAY, 1) }],
  ])('Monday %s UTC', (_label, now, expected) => {
    expect(pricingAt(DEEPSEEK_SCHEDULE, now)).toEqual(expected)
  })

  it('Friday 10:00 UTC waits for Monday 01:00 UTC', () => {
    expect(pricingAt(DEEPSEEK_SCHEDULE, at('2026-11-20', 10))).toEqual({ phase: 'off-peak', peakAt: at('2026-11-23', 1) })
  })

  it.each(['2026-11-21', '2026-11-22'])('weekend %s is off-peak all day', (date) => {
    for (const hour of [0, 1, 2, 5, 6, 8, 9, 12, 23]) {
      expect(pricingAt(DEEPSEEK_SCHEDULE, at(date, hour))).toEqual({ phase: 'off-peak', peakAt: at('2026-11-23', 1) })
    }
  })

  it('a weekday holiday is off-peak all day and the National Day run is skipped', () => {
    // 2026-10-01 (Thu) … 10-07 (Wed) are off; 10-08 (Thu) is a regular weekday.
    for (const hour of [1, 2, 6, 9]) {
      expect(pricingAt(DEEPSEEK_SCHEDULE, at('2026-10-05', hour))).toEqual({ phase: 'off-peak', peakAt: at('2026-10-08', 1) })
    }
    expect(pricingAt(DEEPSEEK_SCHEDULE, at('2026-09-30', 10))).toEqual({ phase: 'off-peak', peakAt: at('2026-10-08', 1) })
  })

  it('falls back to the weekday rule outside the covered years', () => {
    expect(CN_HOLIDAY_YEARS).not.toContain(2028)
    // 2028-10-02 is a Monday during National Day, but the list does not cover 2028.
    expect(pricingAt(DEEPSEEK_SCHEDULE, at('2028-10-02', 2))).toEqual({ phase: 'peak', offPeakAt: at('2028-10-02', 4) })
  })

  it('merges adjacent windows into one block and reports null without a later peak', () => {
    const adjacent: OffPeakSchedule = {
      ...DEEPSEEK_SCHEDULE,
      peak: [{ days: [1], startMin: 60, endMin: 120 }, { days: [1], startMin: 120, endMin: 180 }],
    }
    expect(pricingAt(adjacent, at(MONDAY, 1, 30))).toEqual({ phase: 'peak', offPeakAt: at(MONDAY, 3) })
    const never: OffPeakSchedule = { ...DEEPSEEK_SCHEDULE, peak: [] }
    expect(pricingAt(never, at(MONDAY, 2))).toEqual({ phase: 'off-peak', peakAt: null })
  })

  it('does not depend on the local time zone', () => {
    expect(new Date(at(MONDAY, 2)).getDay()).toBe(0) // America/New_York: still Sunday evening
    expect(pricingAt(DEEPSEEK_SCHEDULE, at(MONDAY, 2)).phase).toBe('peak')
  })
})

describe('offPeakSnoozeTargets', () => {
  it('is empty during off-peak', () => {
    expect(offPeakSnoozeTargets(DEEPSEEK_SCHEDULE, at(MONDAY, 5))).toEqual([])
    expect(offPeakSnoozeTargets(DEEPSEEK_SCHEDULE, at('2026-11-21', 2))).toEqual([])
  })

  it('offers 04:00 and the longer 10:00 window during the 01:00–04:00 peak', () => {
    expect(LONG_WINDOW_MS).toBe(4 * HOUR_MS)
    expect(offPeakSnoozeTargets(DEEPSEEK_SCHEDULE, at(MONDAY, 2))).toEqual([
      { kind: 'next', until: at(MONDAY, 4), windowMs: 2 * HOUR_MS },
      { kind: 'long', until: at(MONDAY, 10), windowMs: 15 * HOUR_MS },
    ])
  })

  it.each([MONDAY, TUESDAY, '2026-11-18', '2026-11-19'])('offers only 10:00 during the 06:00–10:00 peak on %s', (date) => {
    expect(offPeakSnoozeTargets(DEEPSEEK_SCHEDULE, at(date, 7))).toEqual([
      { kind: 'next', until: at(date, 10), windowMs: 15 * HOUR_MS },
    ])
  })

  it('reports the longer window before a weekend or a holiday', () => {
    expect(offPeakSnoozeTargets(DEEPSEEK_SCHEDULE, at('2026-11-20', 7))).toEqual([
      { kind: 'next', until: at('2026-11-20', 10), windowMs: 63 * HOUR_MS },
    ])
    // 2026-09-25 (Fri) is Mid-Autumn Festival: Thursday 10:00 → Monday 01:00.
    expect(offPeakSnoozeTargets(DEEPSEEK_SCHEDULE, at('2026-09-24', 2))).toEqual([
      { kind: 'next', until: at('2026-09-24', 4), windowMs: 2 * HOUR_MS },
      { kind: 'long', until: at('2026-09-24', 10), windowMs: 87 * HOUR_MS },
    ])
    // National Day: Wednesday 2026-09-30 10:00 → Thursday 2026-10-08 01:00.
    expect(offPeakSnoozeTargets(DEEPSEEK_SCHEDULE, at('2026-09-30', 9, 59))).toEqual([
      { kind: 'next', until: at('2026-09-30', 10), windowMs: at('2026-10-08', 1) - at('2026-09-30', 10) },
    ])
  })

  it('reports a null window when no later peak is within the horizon', () => {
    const once: OffPeakSchedule = { ...DEEPSEEK_SCHEDULE, peak: [{ days: [1], startMin: 60, endMin: 240 }], holidays: new Set(['2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28']) }
    expect(offPeakSnoozeTargets(once, at(MONDAY, 2))).toEqual([{ kind: 'next', until: at(MONDAY, 4), windowMs: null }])
  })
})

describe('isOffPeakTarget', () => {
  it('accepts exactly the offered targets', () => {
    const now = at(MONDAY, 2)
    expect(isOffPeakTarget(DEEPSEEK_SCHEDULE, at(MONDAY, 4), now)).toBe(true)
    expect(isOffPeakTarget(DEEPSEEK_SCHEDULE, at(MONDAY, 10), now)).toBe(true)
    expect(isOffPeakTarget(DEEPSEEK_SCHEDULE, at(MONDAY, 4) + 1, now)).toBe(false)
    expect(isOffPeakTarget(DEEPSEEK_SCHEDULE, at(MONDAY, 3), now)).toBe(false)
    expect(isOffPeakTarget(DEEPSEEK_SCHEDULE, at(TUESDAY, 4), now)).toBe(false)
    expect(isOffPeakTarget(DEEPSEEK_SCHEDULE, at(MONDAY, 10), at(MONDAY, 7))).toBe(true)
    expect(isOffPeakTarget(DEEPSEEK_SCHEDULE, at(MONDAY, 4), at(MONDAY, 7))).toBe(false)
  })

  it('accepts nothing during off-peak', () => {
    expect(isOffPeakTarget(DEEPSEEK_SCHEDULE, at(MONDAY, 10), at(MONDAY, 5))).toBe(false)
    expect(isOffPeakTarget(DEEPSEEK_SCHEDULE, at(MONDAY, 6), at(MONDAY, 5))).toBe(false)
  })
})

describe('bundled holiday data', () => {
  it('is sorted, unique, Monday–Friday and inside the covered years', () => {
    expect([...CN_WEEKDAY_OFF_DAYS].sort()).toEqual(CN_WEEKDAY_OFF_DAYS)
    expect(new Set(CN_WEEKDAY_OFF_DAYS).size).toBe(CN_WEEKDAY_OFF_DAYS.length)
    expect([...CN_HOLIDAY_YEARS].sort((a, b) => a - b)).toEqual(CN_HOLIDAY_YEARS)
    for (const date of CN_WEEKDAY_OFF_DAYS) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      const day = new Date(`${date}T00:00:00Z`).getUTCDay()
      expect(day >= 1 && day <= 5).toBe(true)
      expect(CN_HOLIDAY_YEARS).toContain(Number(date.slice(0, 4)))
    }
    expect(DEEPSEEK_SCHEDULE.holidays.has('2026-10-01')).toBe(true)
    expect(DEEPSEEK_SCHEDULE.holidayYears).toEqual(CN_HOLIDAY_YEARS)
  })
})
