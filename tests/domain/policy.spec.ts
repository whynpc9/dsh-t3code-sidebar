import { describe, expect, it } from 'vitest'
import { decideAutoSettle } from '../../src/domain/autosettle.ts'
import { acknowledgeResult } from '../../src/domain/commands.ts'
import {
  effectivePolicy, graceSince, heldResult, isAbnormalEnd, isStricter, stricterWorkspaces, unacknowledgedResult,
} from '../../src/domain/policy.ts'
import { DAY_MS, EMPTY_ACTIVITY, type TimePolicy } from '../../src/domain/types.ts'
import { T0, facts, native, record } from './fixtures.ts'

const policy: TimePolicy = {
  revision: 1, autoSettleAfterDays: 7, keepUnacknowledgedFailures: false, keepUnacknowledgedResults: false,
  workspaceOverrides: { off: { mode: 'off' }, short: { mode: 'custom', days: 2 } },
}
const ended = (seq: number, reason: string) => ({ ...EMPTY_ACTIVITY, lastTurnEnd: { seq, at: T0, reason } })

describe('effectivePolicy', () => {
  it('resolves Host default → workspace override, keeping off distinct from inherit', () => {
    expect(effectivePolicy(policy, null)).toMatchObject({ days: 7, source: 'host' })
    expect(effectivePolicy(policy, 'plain')).toMatchObject({ days: 7, source: 'host', identity: 'host:7' })
    expect(effectivePolicy(policy, 'off')).toMatchObject({ days: null, source: 'workspace', identity: 'workspace:off:off' })
    expect(effectivePolicy(policy, 'short')).toMatchObject({ days: 2, source: 'workspace' })
    expect(effectivePolicy({ ...policy, autoSettleAfterDays: null }, 'plain')).toMatchObject({ days: null, source: 'host' })
  })
})

describe('grace bookkeeping', () => {
  it('treats enabling and shortening as stricter, never disabling or lengthening', () => {
    expect(isStricter(null, 3)).toBe(true)
    expect(isStricter(7, 3)).toBe(true)
    expect(isStricter(3, 7)).toBe(false)
    expect(isStricter(3, null)).toBe(false)
    expect(isStricter(3, 3)).toBe(false)
  })

  it('finds the workspaces whose effective window became stricter', () => {
    const after: TimePolicy = { ...policy, workspaceOverrides: { off: { mode: 'custom', days: 30 }, short: { mode: 'custom', days: 5 }, added: { mode: 'custom', days: 1 } } }
    expect(stricterWorkspaces(policy, after).sort()).toEqual(['added', 'off'])
    // Removing an override in favor of a stricter default is stricter too.
    expect(stricterWorkspaces({ ...policy, workspaceOverrides: { long: { mode: 'custom', days: 30 } } }, { ...policy, workspaceOverrides: {} })).toEqual(['long'])
  })

  it('applies the Host grace only to the Host default followers', () => {
    const base = { recordSince: 1, hostSince: 50, workspaceSince: undefined, sessionSince: undefined }
    expect(graceSince({ ...base, source: 'host' })).toBe(50)
    expect(graceSince({ ...base, source: 'workspace' })).toBe(1)
    expect(graceSince({ ...base, source: 'workspace', workspaceSince: 70, sessionSince: 60 })).toBe(70)
    expect(graceSince({ ...base, source: 'host', sessionSince: 90 })).toBe(90)
  })
})

describe('result acknowledgement', () => {
  it('classifies every ending but completed and cancelled as abnormal', () => {
    for (const reason of ['error', 'blocked', 'max-tokens', 'interrupted', 'unknown', 'something-new']) expect(isAbnormalEnd(reason)).toBe(true)
    for (const reason of ['completed', 'aborted']) expect(isAbnormalEnd(reason)).toBe(false)
  })

  it('reports the latest result only while it is newer than the shared acknowledgement', () => {
    expect(unacknowledgedResult(EMPTY_ACTIVITY, null)).toBeNull()
    expect(unacknowledgedResult(ended(4, 'completed'), null)).toEqual({ seq: 4, abnormal: false })
    expect(unacknowledgedResult(ended(4, 'error'), 3)).toEqual({ seq: 4, abnormal: true })
    expect(unacknowledgedResult(ended(4, 'error'), 4)).toBeNull()
  })

  it('holds results only under the protection that covers them', () => {
    const keepFailures = { keepUnacknowledgedFailures: true, keepUnacknowledgedResults: false }
    const keepResults = { keepUnacknowledgedFailures: false, keepUnacknowledgedResults: true }
    expect(heldResult(keepFailures, ended(4, 'completed'), null)).toBeNull()
    expect(heldResult(keepFailures, ended(4, 'blocked'), null)).toBe('unacknowledged-failure')
    expect(heldResult(keepResults, ended(4, 'completed'), null)).toBe('unacknowledged-result')
    expect(heldResult(keepResults, ended(4, 'error'), null)).toBe('unacknowledged-failure')
    expect(heldResult(keepResults, ended(4, 'completed'), 4)).toBeNull()
  })

  it('acknowledges only folded results and never moves the mark backwards', () => {
    const withResult = record({ activity: ended(4, 'error') })
    expect(acknowledgeResult(record(), 1)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(acknowledgeResult(withResult, 5)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const first = acknowledgeResult(withResult, 4)
    expect(first).toMatchObject({ ok: true, record: { resultAcknowledgedSeq: 4, revision: 1 } })
    const older = acknowledgeResult(first.ok ? first.record : withResult, 2)
    expect(older).toMatchObject({ ok: true, record: { resultAcknowledgedSeq: 4, revision: 2 } })
  })
})

describe('decideAutoSettle with scopes and acknowledgement', () => {
  const late = T0 + 30 * DAY_MS
  const decide = (patch: Partial<Parameters<typeof decideAutoSettle>[0]>) => decideAutoSettle({
    policy, record: record({ policyEligibleSince: T0 }), facts: facts(), native, createdAt: T0, now: late, ...patch,
  })

  it('T02: a workspace override wins over the Host default, and off names its source', () => {
    expect(decide({ workspaceId: 'off' })).toMatchObject({ eligible: false, skip: 'workspace-off', source: 'workspace' })
    expect(decide({ workspaceId: 'short', now: T0 + 2 * DAY_MS + 1 })).toMatchObject({ eligible: true, deadline: T0 + 2 * DAY_MS, days: 2 })
    expect(decide({ workspaceId: 'plain', now: T0 + 2 * DAY_MS + 1 })).toMatchObject({ eligible: false, skip: 'not-due', days: 7 })
    expect(decide({ workspaceId: 'short', policy: { ...policy, autoSettleAfterDays: null } })).toMatchObject({ eligible: true })
  })

  it('never settles under an unknown rule or an unknown latest result', () => {
    expect(decide({ workspaceId: null, scopeKnown: false })).toMatchObject({ eligible: false, skip: 'scope-unknown' })
    // Without overrides the rule is the Host default whatever the membership.
    expect(decide({ policy: { ...policy, workspaceOverrides: {} }, scopeKnown: false }).eligible).toBe(true)
    const keep = { ...policy, keepUnacknowledgedFailures: true }
    expect(decide({ policy: keep, facts: facts({}), record: record({ policyEligibleSince: T0 }) }).eligible).toBe(true)
    expect(decide({ policy: keep, facts: { ...facts({}), resultHistoryKnown: false } })).toMatchObject({ skip: 'result-unknown' })
    // With no keep protection the latest result does not matter.
    expect(decide({ facts: { ...facts({}), resultHistoryKnown: false } }).eligible).toBe(true)
  })

  it('T09: an acknowledged result no longer holds the session', () => {
    const keep = { ...policy, keepUnacknowledgedResults: true }
    const summary = ended(4, 'completed')
    expect(decide({ policy: keep, facts: facts({ summary }), record: record({ policyEligibleSince: T0, activity: summary }) }).skip).toBe('unacknowledged-result')
    expect(decide({ policy: keep, facts: facts({ summary }), record: record({ policyEligibleSince: T0, activity: summary, resultAcknowledgedSeq: 4 }) }).eligible).toBe(true)
  })
})

describe('mergeHistory', () => {
  const human = (time: number, seq: number) => ({ type: 'user/message' as const, seq, time, human: true })
  const start = (time: number, seq: number) => ({ type: 'turn/start' as const, seq, time })
  const end = (time: number, seq: number, reason = 'error') => ({ type: 'turn/end' as const, seq, time, reason })

  it('keeps a Settle accepted before the replay: history before it does not reopen, later activity does', async () => {
    const { settle } = await import('../../src/domain/commands.ts')
    const { reopenReason } = await import('../../src/domain/placement.ts')
    const { mergeHistory } = await import('../../src/domain/commands.ts')
    const settled = settle(record(), facts(), native, T0 + 100)
    if (!settled.ok) throw new Error('settle refused')
    const merged = mergeHistory(settled.record, [human(T0 + 10, 1), start(T0 + 11, 2), end(T0 + 20, 3, 'completed')])
    expect(merged.activity.lastUserInputAt).toBe(T0 + 10)
    expect(merged.disposition.kind === 'settled' && reopenReason(merged.disposition, facts({ summary: merged.activity }))).toBe(null)
    const later = mergeHistory(settled.record, [human(T0 + 10, 1), human(T0 + 200, 4)])
    expect(later.disposition.kind === 'settled' && reopenReason(later.disposition, facts({ summary: later.activity }))).toBe('user-input')
  })

  it('keeps a Snooze accepted before the replay: an older failure does not wake it, a later one does', async () => {
    const { snooze, mergeHistory } = await import('../../src/domain/commands.ts')
    const { wakeReason } = await import('../../src/domain/placement.ts')
    const snoozed = snooze(record(), facts(), native, T0 + 3_600_000, T0 + 100)
    if (!snoozed.ok) throw new Error('snooze refused')
    const merged = mergeHistory(snoozed.record, [start(T0 + 5, 1), end(T0 + 9, 2)])
    expect(merged.disposition.kind === 'snoozed' && wakeReason(merged.disposition, facts({ summary: merged.activity }), T0 + 200)).toBe(null)
    const later = mergeHistory(snoozed.record, [start(T0 + 150, 1), end(T0 + 160, 2)])
    expect(later.disposition.kind === 'snoozed' && wakeReason(later.disposition, facts({ summary: later.activity }), T0 + 200)).toBe('new-failure')
  })

  it('extends a reopen hold over replayed history and leaves records without new events untouched', async () => {
    const { mergeHistory } = await import('../../src/domain/commands.ts')
    const held = record({ autoSettleHold: { baselineUserInputAt: null, baselineTurnStartSeq: null } })
    expect(mergeHistory(held, [human(T0 + 10, 1), start(T0 + 11, 2)]).autoSettleHold).toEqual({ baselineUserInputAt: T0 + 10, baselineTurnStartSeq: 2 })
    expect(mergeHistory(held, [])).toBe(held)
  })
})
