/**
 * Snooze presets and time validation (time-policy spec §4). Calendar math runs
 * in the user's local time zone at the moment of the action; the result is an
 * absolute UTC deadline the Host validates against its own clock.
 */

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const RELATIVE_MAX_MS = 30 * 24 * HOUR_MS
export const ABSOLUTE_MAX_MS = 90 * 24 * HOUR_MS

export type SnoozePresetId = '1h' | '3h' | 'today-18' | 'tomorrow-09' | 'next-monday-09'

export interface SnoozePreset {
  readonly id: SnoozePresetId
  readonly until: number
}

/**
 * Build a local wall-clock instant, or `null` when it does not exist (a
 * daylight-saving gap). Ambiguous repeated times resolve to the earlier offset.
 */
export function localInstant(year: number, monthIndex: number, day: number, hour: number, minute = 0): number | null {
  const date = new Date(year, monthIndex, day, hour, minute, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute) {
    return null
  }
  return date.getTime()
}

/** Default presets, sorted by deadline; past "today" times and DST gaps are omitted. */
export function snoozePresets(now: number): SnoozePreset[] {
  const base = new Date(now)
  const y = base.getFullYear()
  const m = base.getMonth()
  const d = base.getDate()
  const presets: SnoozePreset[] = [
    { id: '1h', until: now + HOUR_MS },
    { id: '3h', until: now + 3 * HOUR_MS },
  ]
  const today18 = localInstant(y, m, d, 18)
  if (today18 !== null && today18 > now) presets.push({ id: 'today-18', until: today18 })
  const tomorrow09 = atDayOffset(y, m, d, 1, 9)
  if (tomorrow09 !== null) presets.push({ id: 'tomorrow-09', until: tomorrow09 })
  // Next Monday strictly after today (Sunday=0 … Saturday=6).
  const daysUntilMonday = ((8 - base.getDay()) % 7) || 7
  const monday09 = atDayOffset(y, m, d, daysUntilMonday, 9)
  if (monday09 !== null) presets.push({ id: 'next-monday-09', until: monday09 })
  return presets.sort((left, right) => left.until - right.until)
}

/** Local `hour`:00 on the calendar day `offset` days after y-m-d (month rollover safe). */
function atDayOffset(y: number, m: number, d: number, offset: number, hour: number): number | null {
  // Noon is never inside a DST gap, so it normalizes the calendar day safely.
  const day = new Date(y, m, d + offset, 12)
  return localInstant(day.getFullYear(), day.getMonth(), day.getDate(), hour)
}

export type SnoozeTimeError = 'past' | 'too-far' | 'invalid'

/**
 * Validate a Snooze deadline against the Host clock.
 * @returns null when acceptable, otherwise the reason.
 */
export function validateSnoozeUntil(until: number, serverNow: number): SnoozeTimeError | null {
  if (!Number.isFinite(until) || !Number.isInteger(until)) return 'invalid'
  if (until <= serverNow) return 'past'
  if (until - serverNow > ABSOLUTE_MAX_MS) return 'too-far'
  return null
}

/** Parse a relative duration ("90m", "2h", "3d") into milliseconds within 1 minute … 30 days. */
export function parseRelative(input: string): number | null {
  const match = /^\s*(\d+)\s*(m|min|h|d)\s*$/i.exec(input)
  if (match === null) return null
  const amount = Number(match[1])
  const unit = match[2]!.toLowerCase()
  const ms = amount * (unit === 'd' ? 24 * HOUR_MS : unit === 'h' ? HOUR_MS : MINUTE_MS)
  if (ms < MINUTE_MS || ms > RELATIVE_MAX_MS) return null
  return ms
}
