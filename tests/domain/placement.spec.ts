import { describe, expect, it } from 'vitest'
import { derivePlacement, rowStatus } from '../../src/domain/placement.ts'
import { reconcile, reopen, settle, snooze } from '../../src/domain/commands.ts'
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

  it('pin masks the snooze without clearing it; unpin brings it back', () => {
    const r = snoozed()
    expect(derivePlacement(base, r, { pinned: true, archived: false }, T0 + 1)).toBe('pinned')
    expect(r.disposition.kind).toBe('snoozed')
    expect(derivePlacement(base, r, native, T0 + 1)).toBe('snoozed')
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
