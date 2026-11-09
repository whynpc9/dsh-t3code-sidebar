import { describe, expect, it } from 'vitest'
import { HOUR_MS, localInstant, parseLocalDateTime, parseRelative, snoozePresets, validateSnoozeUntil } from '../../src/domain/time.ts'

describe('snoozePresets', () => {
  it('orders presets and hides today 18:00 once it passed', () => {
    const morning = new Date(2026, 10, 9, 10, 0).getTime() // Monday
    const ids = snoozePresets(morning).map(preset => preset.id)
    expect(ids).toEqual(['1h', '3h', 'today-18', 'tomorrow-09', 'next-monday-09'])
    const evening = new Date(2026, 10, 9, 19, 0).getTime()
    expect(snoozePresets(evening).map(preset => preset.id)).not.toContain('today-18')
  })

  it('next Monday is strictly after today and month rollover is safe', () => {
    const monday = new Date(2026, 10, 30, 10, 0).getTime() // Monday 30 Nov
    const presets = Object.fromEntries(snoozePresets(monday).map(preset => [preset.id, preset.until]))
    expect(new Date(presets['tomorrow-09']!).getDate()).toBe(1)
    expect(new Date(presets['next-monday-09']!).getDate()).toBe(7)
  })
})

describe('time validation', () => {
  it('rejects past and too-far deadlines', () => {
    expect(validateSnoozeUntil(1000, 1000)).toBe('past')
    expect(validateSnoozeUntil(1000 + 91 * 24 * HOUR_MS, 1000)).toBe('too-far')
    expect(validateSnoozeUntil(1000 + HOUR_MS, 1000)).toBeNull()
  })

  it('parses relative durations within 1 minute … 30 days', () => {
    expect(parseRelative('90m')).toBe(90 * 60_000)
    expect(parseRelative('2h')).toBe(2 * HOUR_MS)
    expect(parseRelative('31d')).toBeNull()
    expect(parseRelative('0m')).toBeNull()
  })

  it('rejects wall-clock times inside a DST gap', () => {
    // America/New_York springs forward 2026-03-08 02:00 → 03:00.
    expect(localInstant(2026, 2, 8, 2, 30)).toBeNull()
    expect(localInstant(2026, 2, 8, 3, 30)).not.toBeNull()
  })
})

describe('parseLocalDateTime', () => {
  it('parses datetime-local values and rejects times inside a DST gap', () => {
    expect(parseLocalDateTime('2027-03-14T02:30')).toBeNull() // New York springs forward 02:00 → 03:00
    expect(parseLocalDateTime('2027-03-14T03:30')).toBe(new Date(2027, 2, 14, 3, 30).getTime())
    expect(parseLocalDateTime('2026-11-20T09:05:00')).toBe(new Date(2026, 10, 20, 9, 5).getTime())
    expect(parseLocalDateTime('not a date')).toBeNull()
  })
})
