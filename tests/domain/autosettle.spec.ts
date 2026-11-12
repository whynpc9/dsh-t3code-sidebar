import { describe, expect, it } from 'vitest'
import { decideAutoSettle } from '../../src/domain/autosettle.ts'
import { reopen, settle } from '../../src/domain/commands.ts'
import { DAY_MS, type TimePolicy } from '../../src/domain/types.ts'
import { T0, facts, native, question, record } from './fixtures.ts'

const policy: TimePolicy = { revision: 1, autoSettleAfterDays: 7, keepUnacknowledgedFailures: false, keepUnacknowledgedResults: false, workspaceOverrides: {} }
const idle = facts()
const decide = (patch: Partial<Parameters<typeof decideAutoSettle>[0]>) => decideAutoSettle({
  policy, record: record({ policyEligibleSince: T0 }), facts: idle, native, createdAt: T0, now: T0, ...patch,
})

describe('decideAutoSettle', () => {
  it('T01: settles only strictly after the deadline', () => {
    expect(decide({ now: T0 + 7 * DAY_MS - 1 })).toMatchObject({ eligible: false, skip: 'not-due' })
    expect(decide({ now: T0 + 7 * DAY_MS })).toMatchObject({ eligible: false, skip: 'not-due' })
    expect(decide({ now: T0 + 7 * DAY_MS + 1 })).toMatchObject({ eligible: true, deadline: T0 + 7 * DAY_MS })
  })

  it('T02: policy off and per-session disable stop it', () => {
    const late = T0 + 30 * DAY_MS
    expect(decide({ now: late, policy: { ...policy, autoSettleAfterDays: null } }).skip).toBe('policy-off')
    expect(decide({ now: late, record: record({ policyOverride: 'disabled' }) }).skip).toBe('session-disabled')
  })

  it('T03: every protection skips with a visible reason', () => {
    const late = T0 + 30 * DAY_MS
    expect(decide({ now: late, native: { pinned: true, archived: false } }).skip).toBe('pinned')
    expect(decide({ now: late, facts: facts({ running: true }) }).skip).toBe('running')
    expect(decide({ now: late, facts: facts({ activity: ['subagent'] }) }).skip).toBe('active-work')
    expect(decide({ now: late, facts: facts({ activity: ['schedule'] }) }).skip).toBe('active-work')
    expect(decide({ now: late, facts: facts({ pending: [question] }) }).skip).toBe('pending')
    expect(decide({ now: late, facts: facts({ running: 'unknown' }) }).skip).toBe('running-unknown')
    expect(decide({ now: late, facts: facts({ activity: 'unknown' }) }).skip).toBe('activity-unknown')
    expect(decide({ now: late, facts: facts({ pending: 'unknown' }) }).skip).toBe('pending-unknown')
  })

  it('T04: a Snooze wake restarts the full window', () => {
    const woke = T0 + 10 * DAY_MS
    const r = record({ policyEligibleSince: T0, lastSnoozeWakeAt: woke })
    expect(decide({ record: r, now: woke + DAY_MS }).skip).toBe('not-due')
    expect(decide({ record: r, now: woke + 7 * DAY_MS + 1 }).eligible).toBe(true)
  })

  it('T05: a manual reopen holds until new activity', () => {
    const settled = settle(record({ policyEligibleSince: T0 }), idle, native, T0)
    if (!settled.ok) throw new Error()
    const reopened = reopen(settled.record, T0 + 1)
    if (!reopened.ok) throw new Error()
    expect(decide({ record: reopened.record, now: T0 + 30 * DAY_MS }).skip).toBe('reopen-hold')
  })

  it('T07: the grace window starts when the policy first applies, not at old activity', () => {
    const installedAt = T0 + 100 * DAY_MS
    const r = record({ policyEligibleSince: installedAt, activity: { lastUserInputAt: T0, lastTurnStartAt: T0, lastTurnStartSeq: 1, lastTurnEnd: { seq: 2, at: T0, reason: 'completed' } } })
    expect(decide({ record: r, now: installedAt + DAY_MS }).skip).toBe('not-due')
    expect(decide({ record: r, now: installedAt + 7 * DAY_MS + 1 }).eligible).toBe(true)
  })

  it('T09: failures settle by default and are kept only when the option is on', () => {
    const failed = facts({ summary: { lastTurnEnd: { seq: 2, at: T0, reason: 'error' } } })
    const late = T0 + 30 * DAY_MS
    expect(decide({ now: late, facts: failed }).eligible).toBe(true)
    expect(decide({ now: late, facts: failed, policy: { ...policy, keepUnacknowledgedFailures: true, keepUnacknowledgedResults: false, workspaceOverrides: {} } }).skip).toBe('unacknowledged-failure')
  })
})
