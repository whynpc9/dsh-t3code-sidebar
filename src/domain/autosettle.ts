/**
 * Automatic settling after inactivity (time-policy spec §3). Pure: the Host
 * scheduler feeds facts and commits the result through its serial queue.
 */
import { effectiveDisposition } from './placement.ts'
import { effectivePolicy, heldResult, type PolicySource } from './policy.ts'
import { DAY_MS, type NativeState, type TaskFacts, type TaskRecord, type TimePolicy } from './types.ts'

export type AutoSettleSkip =
  | 'policy-off'
  | 'workspace-off'
  | 'session-disabled'
  | 'reopen-hold'
  | 'archived'
  | 'pinned'
  | 'parked'
  | 'running-unknown'
  | 'running'
  | 'activity-unknown'
  | 'active-work'
  | 'pending-unknown'
  | 'pending'
  | 'unacknowledged-failure'
  | 'unacknowledged-result'
  | 'not-due'

export interface AutoSettleDecision {
  readonly eligible: boolean
  readonly skip: AutoSettleSkip | null
  /** Inactivity anchor before the grace window is applied. */
  readonly anchorAt: number
  /** Instant after which the session is due; `null` when the policy is off. */
  readonly deadline: number | null
  /** Effective window and where it comes from (Host default or workspace override). */
  readonly days: number | null
  readonly source: PolicySource
}

const maxOf = (...values: readonly (number | null | undefined)[]): number => {
  let best = 0
  for (const value of values) if (typeof value === 'number' && value > best) best = value
  return best
}

/** Inactivity anchor: latest human input, turn boundary, wake, or creation. */
export function inactivityAnchor(record: TaskRecord, createdAt: number): number {
  const summary = record.activity
  return maxOf(
    createdAt,
    summary.lastUserInputAt,
    summary.lastTurnStartAt,
    summary.lastTurnEnd?.at,
    record.lastSnoozeWakeAt,
  )
}

/**
 * Decide whether one session should be settled now. Every unknown fact skips:
 * unknown is never treated as idle.
 */
export function decideAutoSettle(input: {
  readonly policy: TimePolicy
  /** The session's workspace (selects a workspace override); null or omitted: none. */
  readonly workspaceId?: string | null
  readonly record: TaskRecord
  readonly facts: TaskFacts
  readonly native: NativeState
  readonly createdAt: number
  readonly now: number
}): AutoSettleDecision {
  const { policy, record, facts, native, createdAt, now } = input
  const anchorAt = inactivityAnchor(record, createdAt)
  const effective = effectivePolicy(policy, input.workspaceId ?? null)
  const days = effective.days
  const deadline = days === null ? null : Math.max(anchorAt, record.policyEligibleSince) + days * DAY_MS
  const skip = (reason: AutoSettleSkip): AutoSettleDecision =>
    ({ eligible: false, skip: reason, anchorAt, deadline, days, source: effective.source })

  if (days === null || deadline === null) return skip(effective.source === 'workspace' ? 'workspace-off' : 'policy-off')
  if (record.policyOverride === 'disabled') return skip('session-disabled')
  if (record.autoSettleHold !== null) return skip('reopen-hold')
  if (native.archived) return skip('archived')
  if (native.pinned) return skip('pinned')
  if (effectiveDisposition(record, facts, now) !== 'normal' || record.disposition.kind !== 'normal') return skip('parked')
  if (!facts.running.known) return skip('running-unknown')
  if (facts.running.value) return skip('running')
  if (!facts.activity.known) return skip('activity-unknown')
  if (facts.activity.value.length > 0) return skip('active-work')
  if (!facts.pending.known) return skip('pending-unknown')
  if (facts.pending.value.length > 0) return skip('pending')
  const held = heldResult(policy, facts.summary, record.resultAcknowledgedSeq)
  if (held !== null) return skip(held)
  if (!(now > deadline)) return skip('not-due')
  return { eligible: true, skip: null, anchorAt, deadline, days, source: effective.source }
}
