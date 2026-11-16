import { describe, expect, it } from 'vitest'
import { derivePlacement, rowStatus } from '../../src/domain/placement.ts'
import { CapabilitiesSchema, CommandActionSchema, TaskRecordSchema } from '../../src/contracts/schema.ts'
import { attachResume, mergeHistory, reconcile, reopen, resumeRefusal, settle, snooze } from '../../src/domain/commands.ts'
import { comparatorFor } from '../../src/domain/sort.ts'
import { HOUR_MS } from '../../src/domain/time.ts'
import { T0, approval, facts, native, question, record } from './fixtures.ts'

describe('derivePlacement', () => {
  it('excludes archived sessions and keeps pinned ones in Pinned regardless of state', () => {
    expect(derivePlacement(facts({ running: true }), undefined, { pinned: false, archived: true }, T0)).toBeNull()
    expect(derivePlacement(facts({ running: true }), undefined, { pinned: true, archived: false }, T0)).toBe('pinned')
    expect(derivePlacement(facts({ pending: [approval] }), undefined, { pinned: true, archived: false }, T0)).toBe('pinned')
  })

  it('A02: running → approval → running → finished maps Working → Active → Working → Active', () => {
    expect(derivePlacement(facts({ running: true }), undefined, native, T0)).toBe('working')
    expect(derivePlacement(facts({ running: true, pending: [approval] }), undefined, native, T0)).toBe('active')
    expect(derivePlacement(facts({ running: true }), undefined, native, T0)).toBe('working')
    const done = facts({ summary: { lastTurnStartSeq: 1, lastTurnEnd: { seq: 9, at: T0, reason: 'completed' } } })
    expect(derivePlacement(done, undefined, native, T0)).toBe('active')
    expect(rowStatus(done, null)).toBe('new-result')
    expect(rowStatus(done, 9)).toBe('idle')
  })

  it('treats subagents and jobs as working but a schedule alone as idle', () => {
    expect(derivePlacement(facts({ activity: ['subagent'] }), undefined, native, T0)).toBe('working')
    expect(derivePlacement(facts({ activity: ['job'] }), undefined, native, T0)).toBe('working')
    expect(derivePlacement(facts({ activity: ['schedule'] }), undefined, native, T0)).toBe('active')
  })

  it('never reports unknown running as idle', () => {
    expect(rowStatus(facts({ running: 'unknown', activity: 'unknown' }), null)).toBe('unknown')
  })

  it('does not label an unfamiliar turn end reason as a completed result', () => {
    const outcome = facts({ summary: { lastTurnStartSeq: 1, lastTurnEnd: { seq: 9, at: T0, reason: 'future-reason' } } })
    expect(rowStatus(outcome, null)).toBe('needs-check')
    expect(derivePlacement(outcome, undefined, native, T0)).toBe('active')
  })
})

describe('Snooze', () => {
  const base = facts({ pending: [question] })
  const snoozed = () => {
    const result = snooze(record(), base, native, T0 + HOUR_MS, T0)
    if (!result.ok) throw new Error(result.code)
    return result.record
  }

  it('refuses pinned sessions, approvals, unknown baselines and past deadlines', () => {
    expect(snooze(record(), base, { pinned: true, archived: false }, T0 + HOUR_MS, T0)).toMatchObject({ ok: false, code: 'PINNED' })
    expect(snooze(record(), facts({ pending: [approval] }), native, T0 + HOUR_MS, T0)).toMatchObject({ ok: false, code: 'PENDING_APPROVAL' })
    expect(snooze(record(), facts({ pending: 'unknown' }), native, T0 + HOUR_MS, T0)).toMatchObject({ ok: false, code: 'BASELINE_PENDING' })
    expect(snooze(record(), base, native, T0 - 1, T0)).toMatchObject({ ok: false, code: 'INVALID_TIME' })
  })

  it('allows snoozing a running session', () => {
    expect(snooze(record(), facts({ running: true }), native, T0 + HOUR_MS, T0).ok).toBe(true)
  })

  it('A03: the already-known question does not wake it; a new question wakes it once', () => {
    const r = snoozed()
    expect(derivePlacement(base, r, native, T0 + 1)).toBe('snoozed')
    expect(reconcile(r, base, native, T0 + 1)).toBeNull()
    const fresh = facts({ pending: [question, { ...question, key: 'q2' }] })
    expect(derivePlacement(fresh, r, native, T0 + 1)).toBe('active')
    const woken = reconcile(r, fresh, native, T0 + 1)
    expect(woken?.disposition.kind).toBe('normal')
    expect(reconcile(woken!, fresh, native, T0 + 2)).toBeNull()
  })

  it('A04: an ordinary completion does not wake it; expiry does and anchors the wake at the deadline', () => {
    const r = snoozed()
    const completed = facts({ summary: { lastTurnStartSeq: 1, lastTurnEnd: { seq: 5, at: T0 + 10, reason: 'completed' } } })
    expect(reconcile(r, completed, native, T0 + 10)).toBeNull()
    const expired = reconcile(r, completed, native, T0 + 2 * HOUR_MS)
    expect(expired).toMatchObject({ disposition: { kind: 'normal' }, lastSnoozeWakeAt: T0 + HOUR_MS })
  })

  it('a new failure or human input wakes it early', () => {
    const r = snoozed()
    const failed = facts({ summary: { lastTurnEnd: { seq: 7, at: T0 + 5, reason: 'error' } } })
    expect(reconcile(r, failed, native, T0 + 5)?.disposition.kind).toBe('normal')
    const typed = facts({ summary: { lastUserInputAt: T0 + 5 } })
    expect(reconcile(r, typed, native, T0 + 5)?.disposition.kind).toBe('normal')
  })

  it('a known question that switches source (durable ask → live) is not a new request', () => {
    const r = snoozed()
    const moved = facts({ pending: [{ source: 'live', key: question.key, kind: 'user-question' }] })
    expect(derivePlacement(moved, r, native, T0 + 1)).toBe('snoozed')
    expect(reconcile(r, moved, native, T0 + 1)).toBeNull()
  })

  it('pin masks the snooze without clearing it; unpin brings it back', () => {
    const r = snoozed()
    expect(derivePlacement(base, r, { pinned: true, archived: false }, T0 + 1)).toBe('pinned')
    expect(r.disposition.kind).toBe('snoozed')
    expect(derivePlacement(base, r, native, T0 + 1)).toBe('snoozed')
  })
})

describe('off-peak Snooze', () => {
  const MONDAY_PEAK = Date.UTC(2026, 10, 16, 2) // Monday 02:00 UTC, inside 01:00–04:00 peak
  const OFF_PEAK_AT = Date.UTC(2026, 10, 16, 4)

  it('accepts an offered boundary and stores the origin', () => {
    const result = snooze(record(), facts(), native, OFF_PEAK_AT, MONDAY_PEAK, 'off-peak')
    expect(result).toMatchObject({ ok: true, record: { disposition: { kind: 'snoozed', until: OFF_PEAK_AT, origin: 'off-peak' } } })
    const longer = snooze(record(), facts(), native, Date.UTC(2026, 10, 16, 10), MONDAY_PEAK, 'off-peak')
    expect(longer).toMatchObject({ ok: true, record: { disposition: { origin: 'off-peak' } } })
  })

  it('refuses a non-boundary deadline and any off-peak snooze issued during off-peak', () => {
    expect(snooze(record(), facts(), native, OFF_PEAK_AT + 60_000, MONDAY_PEAK, 'off-peak')).toMatchObject({ ok: false, code: 'INVALID_TIME' })
    expect(snooze(record(), facts(), native, Date.UTC(2026, 10, 16, 6), Date.UTC(2026, 10, 16, 5), 'off-peak'))
      .toMatchObject({ ok: false, code: 'INVALID_TIME' })
    expect(snooze(record(), facts(), native, MONDAY_PEAK - 1, MONDAY_PEAK, 'off-peak')).toMatchObject({ ok: false, code: 'INVALID_TIME' })
  })

  it('leaves ordinary snoozes without an origin', () => {
    const result = snooze(record(), facts(), native, OFF_PEAK_AT + 60_000, MONDAY_PEAK)
    if (!result.ok) throw new Error(result.code)
    expect('origin' in result.record.disposition).toBe(false)
  })

  it('keeps the origin when replayed history advances the baselines', () => {
    const result = snooze(record(), facts(), native, OFF_PEAK_AT, MONDAY_PEAK, 'off-peak')
    if (!result.ok) throw new Error(result.code)
    const merged = mergeHistory(result.record, [{ type: 'turn/end', seq: 4, time: MONDAY_PEAK - 1000, reason: 'completed' }])
    expect(merged.disposition).toMatchObject({ kind: 'snoozed', baselineTurnEndSeq: 4, origin: 'off-peak' })
  })

  it('parses stored records with and without an origin', () => {
    const result = snooze(record(), facts(), native, OFF_PEAK_AT, MONDAY_PEAK, 'off-peak')
    if (!result.ok) throw new Error(result.code)
    expect(TaskRecordSchema.parse(JSON.parse(JSON.stringify(result.record))).disposition).toMatchObject({ origin: 'off-peak' })
    const legacy = { ...result.record, disposition: { ...result.record.disposition, origin: undefined } }
    const parsed = TaskRecordSchema.parse(JSON.parse(JSON.stringify(legacy)))
    expect(parsed.disposition.kind).toBe('snoozed')
    expect('origin' in parsed.disposition).toBe(false)
    expect(() => TaskRecordSchema.parse({ ...result.record, disposition: { ...result.record.disposition, origin: 'other' } })).toThrow()
    expect(CommandActionSchema.parse({ kind: 'snooze', until: OFF_PEAK_AT })).toEqual({ kind: 'snooze', until: OFF_PEAK_AT })
    expect(CommandActionSchema.parse({ kind: 'snooze', until: OFF_PEAK_AT, origin: 'off-peak' })).toMatchObject({ origin: 'off-peak' })
    expect(CommandActionSchema.safeParse({ kind: 'snooze', until: OFF_PEAK_AT, origin: 'peak' }).success).toBe(false)
  })
})

describe('Resume at off-peak', () => {
  const MONDAY_PEAK = Date.UTC(2026, 10, 16, 2) // Monday 02:00 UTC, inside 01:00–04:00 peak
  const OFF_PEAK_AT = Date.UTC(2026, 10, 16, 4)

  it('is allowed only for a fully idle session with an off-peak deadline', () => {
    expect(resumeRefusal(facts(), 'off-peak')).toBeNull()
    expect(resumeRefusal(facts(), undefined)).toMatchObject({ ok: false, code: 'INVALID_TIME' })
    expect(resumeRefusal(facts({ running: true }), 'off-peak')).toMatchObject({ code: 'SESSION_ACTIVE' })
    expect(resumeRefusal(facts({ activity: ['subagent'] }), 'off-peak')).toMatchObject({ code: 'SESSION_ACTIVE' })
    expect(resumeRefusal(facts({ activity: ['job'] }), 'off-peak')).toMatchObject({ code: 'SESSION_ACTIVE' })
    expect(resumeRefusal(facts({ running: 'unknown' }), 'off-peak')).toMatchObject({ code: 'BASELINE_PENDING' })
    expect(resumeRefusal(facts({ activity: 'unknown' }), 'off-peak')).toMatchObject({ code: 'BASELINE_PENDING' })
    expect(resumeRefusal(facts({ pending: 'unknown' }), 'off-peak')).toMatchObject({ code: 'BASELINE_PENDING' })
    expect(resumeRefusal(facts({ pending: [approval] }), 'off-peak')).toMatchObject({ code: 'PENDING_APPROVAL' })
    expect(resumeRefusal(facts({ pending: [question] }), 'off-peak')).toMatchObject({ code: 'PENDING_INPUT' })
  })

  it('rides on the off-peak snooze checks (non-boundary deadline, off-peak now)', () => {
    expect(snooze(record(), facts(), native, OFF_PEAK_AT + 60_000, MONDAY_PEAK, 'off-peak')).toMatchObject({ ok: false, code: 'INVALID_TIME' })
    expect(snooze(record(), facts(), native, Date.UTC(2026, 10, 16, 6), Date.UTC(2026, 10, 16, 5), 'off-peak'))
      .toMatchObject({ ok: false, code: 'INVALID_TIME' })
  })

  it('stores only the schedule id on the snoozed disposition, and the record round-trips', () => {
    const result = snooze(record(), facts(), native, OFF_PEAK_AT, MONDAY_PEAK, 'off-peak')
    if (!result.ok) throw new Error(result.code)
    const resumed = attachResume(result.record, 'schedule-1')
    expect(resumed.disposition).toEqual({ ...result.record.disposition, resume: { scheduleId: 'schedule-1' } })
    expect(resumed.revision).toBe(result.record.revision)
    expect(JSON.stringify(resumed)).not.toContain('Continue')
    expect(TaskRecordSchema.parse(JSON.parse(JSON.stringify(resumed))).disposition).toMatchObject({ resume: { scheduleId: 'schedule-1' } })
    // Replayed history keeps it; a wake drops it.
    const merged = mergeHistory(resumed, [{ type: 'turn/end', seq: 4, time: MONDAY_PEAK - 1000, reason: 'completed' }])
    expect(merged.disposition).toMatchObject({ resume: { scheduleId: 'schedule-1' } })
    const woken = reopen(resumed, MONDAY_PEAK + 1000)
    expect(woken).toMatchObject({ ok: true, record: { disposition: { kind: 'normal' } } })
    expect(attachResume(record(), 'x').disposition).toEqual({ kind: 'normal' })
  })

  it('validates the resume action on the wire', () => {
    const action = { kind: 'snooze', until: OFF_PEAK_AT, origin: 'off-peak', resume: { prompt: '  Continue.  ' } }
    expect(CommandActionSchema.parse(action)).toEqual({ ...action, resume: { prompt: 'Continue.' } })
    expect(CommandActionSchema.safeParse({ ...action, origin: undefined }).success).toBe(false)
    expect(CommandActionSchema.safeParse({ ...action, resume: { prompt: '   ' } }).success).toBe(false)
    expect(CommandActionSchema.safeParse({ ...action, resume: { prompt: 'x'.repeat(4001) } }).success).toBe(false)
    expect(CommandActionSchema.safeParse({ ...action, resume: { prompt: 'x'.repeat(4000) } }).success).toBe(true)
    expect(CommandActionSchema.safeParse({ ...action, resume: { prompt: 'go', extra: 1 } }).success).toBe(false)
  })

  it('parses capabilities and snapshots from Hosts without the scheduler flag', () => {
    expect(CapabilitiesSchema.parse({ hostActivity: true, sessionEvents: true, hostPending: false }).hostSchedule).toBe(false)
    expect(CapabilitiesSchema.parse({ hostActivity: true, sessionEvents: true, hostPending: false, hostSchedule: true }).hostSchedule).toBe(true)
  })
})

describe('Settled', () => {
  it('refuses running, pending and unknown sessions', () => {
    expect(settle(record(), facts({ running: true }), native, T0)).toMatchObject({ ok: false, code: 'SESSION_ACTIVE' })
    expect(settle(record(), facts({ activity: ['subagent'] }), native, T0)).toMatchObject({ ok: false, code: 'SESSION_ACTIVE' })
    expect(settle(record(), facts({ pending: [question] }), native, T0)).toMatchObject({ ok: false, code: 'PENDING_INPUT' })
    expect(settle(record(), facts({ running: 'unknown' }), native, T0)).toMatchObject({ ok: false, code: 'BASELINE_PENDING' })
  })

  it('A05: new input or a new turn reopens it', () => {
    const result = settle(record(), facts(), native, T0)
    if (!result.ok) throw new Error(result.code)
    const settled = result.record
    expect(derivePlacement(facts(), settled, native, T0)).toBe('settled')
    const typed = facts({ summary: { lastUserInputAt: T0 + 1 } })
    expect(derivePlacement(typed, settled, native, T0 + 1)).toBe('active')
    expect(reconcile(settled, typed, native, T0 + 1)?.disposition.kind).toBe('normal')
    const started = facts({ running: true, summary: { lastTurnStartSeq: 3, lastTurnStartAt: T0 + 2 } })
    expect(derivePlacement(started, settled, native, T0 + 2)).toBe('working')
  })

  it('manual reopen installs a hold released only by new activity', () => {
    const settled = settle(record(), facts(), native, T0)
    if (!settled.ok) throw new Error()
    const reopened = reopen(settled.record, T0 + 1)
    if (!reopened.ok) throw new Error()
    expect(reopened.record.autoSettleHold).not.toBeNull()
    expect(reconcile(reopened.record, facts(), native, T0 + 2)).toBeNull()
    const released = reconcile(reopened.record, facts({ summary: { lastUserInputAt: T0 + 3 } }), native, T0 + 3)
    expect(released?.autoSettleHold).toBeNull()
  })
})

describe('Working order', () => {
  it('sorts by turn start and ignores newer list activity when the start is known', () => {
    const row = (id: string, startedAt: number | null, updatedAt: number) => ({
      sessionId: id, record: undefined, pinIndex: -1, fallbackAt: updatedAt,
      facts: facts({ running: true, summary: { lastTurnStartAt: startedAt } }),
    })
    const older = row('older', T0, T0 + 10_000)
    const newer = row('newer', T0 + 5_000, T0 + 5_000)
    const cold = row('cold', null, T0 + 2_000)
    const order = [older, newer, cold].sort(comparatorFor('working')).map(entry => entry.sessionId)
    expect(order).toEqual(['newer', 'cold', 'older'])
  })
})
