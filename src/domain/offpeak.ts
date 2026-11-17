/**
 * DeepSeek off-peak pricing schedule and "Snooze until off-peak" targets.
 * All schedule math runs in UTC on epoch milliseconds; the user's time zone
 * never matters. The peak blocks fall on the same calendar date in UTC and in
 * Beijing (UTC+8), so Beijing holiday dates compare directly with UTC dates.
 */
import { CN_HOLIDAY_YEARS, CN_WEEKDAY_OFF_DAYS } from './holidays-cn.ts'
import { HOUR_MS, MINUTE_MS } from './time.ts'
import { DAY_MS } from './types.ts'

export interface PeakWindow {
  /** UTC days of week, 0 = Sunday … 6 = Saturday. */
  readonly days: readonly number[]
  /** Minutes since UTC midnight; startMin < endMin, never crossing midnight. */
  readonly startMin: number
  readonly endMin: number
}

export interface OffPeakSchedule {
  /** Pricing page the schedule comes from. */
  readonly source: string
  /** 'YYYY-MM-DD' the schedule was last checked against `source`. */
  readonly verifiedOn: string
  readonly peak: readonly PeakWindow[]
  /** Weekday public holidays (off-peak in full), as UTC/Beijing dates 'YYYY-MM-DD'. */
  readonly holidays: ReadonlySet<string>
  /** Years the holiday list covers; other years fall back to the weekday rule. */
  readonly holidayYears: readonly number[]
}

const WEEKDAYS = [1, 2, 3, 4, 5]

/**
 * Peak 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, except Chinese public
 * holidays; everything else is off-peak (half price).
 */
export const DEEPSEEK_SCHEDULE: OffPeakSchedule = {
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  verifiedOn: '2026-11-17',
  peak: [
    { days: WEEKDAYS, startMin: 60, endMin: 240 },
    { days: WEEKDAYS, startMin: 360, endMin: 600 },
  ],
  holidays: new Set(CN_WEEKDAY_OFF_DAYS),
  holidayYears: CN_HOLIDAY_YEARS,
}

export type Pricing =
  | { readonly phase: 'peak'; readonly offPeakAt: number }
  | { readonly phase: 'off-peak'; readonly peakAt: number | null }

/** How far ahead to look for the next peak (National Day plus weekends is long). */
const HORIZON_DAYS = 35

interface Block { readonly start: number; readonly end: number }

/** UTC date 'YYYY-MM-DD' of day number `day` (days since the epoch). */
const dateOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10)

/** Merged peak blocks, in order, over UTC days `fromDay` … `toDay` inclusive. */
function peakBlocks(schedule: OffPeakSchedule, fromDay: number, toDay: number): Block[] {
  const blocks: Block[] = []
  for (let day = fromDay; day <= toDay; day++) {
    // 1970-01-01 was a Thursday.
    const weekday = (((day + 4) % 7) + 7) % 7
    const windows = schedule.peak.filter(window => window.days.includes(weekday))
    if (windows.length === 0 || schedule.holidays.has(dateOf(day))) continue
    const sorted = [...windows].sort((left, right) => left.startMin - right.startMin)
    for (const window of sorted) {
      const start = day * DAY_MS + window.startMin * MINUTE_MS
      const end = day * DAY_MS + window.endMin * MINUTE_MS
      const last = blocks[blocks.length - 1]
      if (last !== undefined && start <= last.end) {
        blocks[blocks.length - 1] = { start: last.start, end: Math.max(last.end, end) }
      } else {
        blocks.push({ start, end })
      }
    }
  }
  return blocks
}

/** Blocks around `now` (from the day before, so a block reaching into today stays whole). */
function blocksAround(schedule: OffPeakSchedule, now: number): Block[] {
  const today = Math.floor(now / DAY_MS)
  return peakBlocks(schedule, today - 1, today + HORIZON_DAYS)
}

export function pricingAt(schedule: OffPeakSchedule, now: number): Pricing {
  const blocks = blocksAround(schedule, now)
  const current = blocks.find(block => block.start <= now && now < block.end)
  if (current !== undefined) return { phase: 'peak', offPeakAt: current.end }
  return { phase: 'off-peak', peakAt: blocks.find(block => block.start > now)?.start ?? null }
}

/** Off-peak windows shorter than this get a second, "longer window" target. */
export const LONG_WINDOW_MS = 4 * HOUR_MS

export interface OffPeakTarget {
  readonly kind: 'next' | 'long'
  /** Snooze deadline: the start of an off-peak window. */
  readonly until: number
  /** Length of that off-peak window in ms, or null when no later peak is found within the horizon. */
  readonly windowMs: number | null
}

/**
 * Snooze targets at `now`. Empty during off-peak. During peak: first the end
 * of the current peak block ('next'); and, only when that window is shorter
 * than LONG_WINDOW_MS, the start of the first later off-peak window that is at
 * least LONG_WINDOW_MS long ('long').
 */
export function offPeakSnoozeTargets(schedule: OffPeakSchedule, now: number): OffPeakTarget[] {
  const blocks = blocksAround(schedule, now)
  const index = blocks.findIndex(block => block.start <= now && now < block.end)
  if (index < 0) return []
  const windowAfter = (i: number): number | null => {
    const following = blocks[i + 1]
    return following === undefined ? null : following.start - blocks[i]!.end
  }
  const nextWindow = windowAfter(index)
  const targets: OffPeakTarget[] = [{ kind: 'next', until: blocks[index]!.end, windowMs: nextWindow }]
  if (nextWindow === null || nextWindow >= LONG_WINDOW_MS) return targets
  for (let i = index + 1; i < blocks.length; i++) {
    const windowMs = windowAfter(i)
    if (windowMs === null || windowMs >= LONG_WINDOW_MS) {
      targets.push({ kind: 'long', until: blocks[i]!.end, windowMs })
      break
    }
  }
  return targets
}

/** Whether `until` is one of the targets offered at `now` (Host-side validation). */
export function isOffPeakTarget(schedule: OffPeakSchedule, until: number, now: number): boolean {
  return offPeakSnoozeTargets(schedule, now).some(target => target.until === until)
}
