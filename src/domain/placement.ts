/**
 * Pure placement rules (product spec §4.2). The Host uses `wakeReason` /
 * `reopenReason` to decide durable transitions; the UI uses `derivePlacement`
 * for immediate display. Neither performs I/O.
 */
import type { Disposition, NativeState, Placement, TaskFacts, TaskRecord } from './types.ts'

/** Why an effective Snooze no longer holds. */
export type WakeReason = 'expired' | 'new-pending' | 'new-failure' | 'user-input'
/** Why an effective Settled no longer holds. */
export type ReopenReason = 'user-input' | 'new-turn' | 'new-pending'

/**
 * Requests compare by key only: the same open question can surface as the
 * live interaction or as a durable ask, and a change of source is not a new
 * request. Stored baselines keep `source:key` and are normalized here.
 */
const newPendingKeys = (facts: TaskFacts, baseline: readonly string[]): boolean => {
  if (!facts.pending.known) return false
  const seen = new Set(baseline.map(requestKeyOf))
  return facts.pending.value.some(signal => !seen.has(signal.key))
}

/** Stable identity of a pending signal as stored in baselines (`source:key`). */
export const pendingId = (signal: { readonly source: string; readonly key: string }): string =>
  `${signal.source}:${signal.key}`

/** The request key of a stored baseline identity. */
export const requestKeyOf = (id: string): string => id.slice(id.indexOf(':') + 1)

/**
 * Whether a Snooze has ended, and why. Ordinary successful completion and
 * background work never wake a snoozed task.
 */
export function wakeReason(
  disposition: Extract<Disposition, { kind: 'snoozed' }>,
  facts: TaskFacts,
  now: number,
): WakeReason | null {
  if (now >= disposition.until) return 'expired'
  if (newPendingKeys(facts, disposition.baselinePending)) return 'new-pending'
  const end = facts.summary.lastTurnEnd
  if (end !== null && end.reason === 'error'
    && (disposition.baselineTurnEndSeq === null || end.seq > disposition.baselineTurnEndSeq)) {
    return 'new-failure'
  }
  const input = facts.summary.lastUserInputAt
  if (input !== null && (disposition.baselineUserInputAt === null || input > disposition.baselineUserInputAt)) {
    return 'user-input'
  }
  return null
}

/** Whether a Settled task has new activity that reopens it. */
export function reopenReason(
  disposition: Extract<Disposition, { kind: 'settled' }>,
  facts: TaskFacts,
): ReopenReason | null {
  const input = facts.summary.lastUserInputAt
  if (input !== null && (disposition.baselineUserInputAt === null || input > disposition.baselineUserInputAt)) {
    return 'user-input'
  }
  const start = facts.summary.lastTurnStartSeq
  if (start !== null && (disposition.baselineTurnStartSeq === null || start > disposition.baselineTurnStartSeq)) {
    return 'new-turn'
  }
  if (newPendingKeys(facts, disposition.baselinePending)) return 'new-pending'
  return null
}

/** The disposition that currently holds after applying wake/reopen rules. */
export function effectiveDisposition(record: TaskRecord | undefined, facts: TaskFacts, now: number): Disposition['kind'] {
  if (record === undefined) return 'normal'
  const disposition = record.disposition
  if (disposition.kind === 'snoozed') return wakeReason(disposition, facts, now) === null ? 'snoozed' : 'normal'
  if (disposition.kind === 'settled') return reopenReason(disposition, facts) === null ? 'settled' : 'normal'
  return 'normal'
}

/** Whether something awaits the user right now. */
export const needsAttention = (facts: TaskFacts): boolean =>
  facts.pending.known && facts.pending.value.length > 0

/** Whether the session (or its subagents/jobs) is executing work. Schedules alone do not count. */
export function isWorking(facts: TaskFacts): boolean {
  if (facts.running.known && facts.running.value) return true
  if (facts.activity.known) return facts.activity.value.some(kind => kind === 'turn' || kind === 'subagent' || kind === 'job')
  return false
}

/**
 * Section of one session, or `null` when it belongs to the archive filter.
 * Shared by both views so a session is always in exactly one place.
 */
export function derivePlacement(
  facts: TaskFacts,
  record: TaskRecord | undefined,
  native: NativeState,
  now: number,
): Placement | null {
  if (native.archived) return null
  if (native.pinned) return 'pinned'
  const parked = effectiveDisposition(record, facts, now)
  if (parked === 'snoozed') return 'snoozed'
  if (parked === 'settled') return 'settled'
  if (!needsAttention(facts) && isWorking(facts)) return 'working'
  return 'active'
}

/** Row status badge, highest priority first. */
export type RowStatus = 'approval' | 'input' | 'attention' | 'running' | 'failed' | 'new-result' | 'needs-check' | 'unknown' | 'idle'

/**
 * Compute the row badge.
 * @param lastSeenTurnEndSeq - this browser's read marker for the session.
 */
export function rowStatus(facts: TaskFacts, lastSeenTurnEndSeq: number | null): RowStatus {
  if (facts.pending.known && facts.pending.value.length > 0) {
    const kinds = facts.pending.value.map(signal => signal.kind)
    if (kinds.some(kind => kind.includes('approval'))) return 'approval'
    if (kinds.some(kind => kind.includes('question') || kind.includes('input'))) return 'input'
    return 'attention'
  }
  if (isWorking(facts)) return 'running'
  if (!facts.running.known) return 'unknown'
  const end = facts.summary.lastTurnEnd
  if (end !== null && (facts.summary.lastTurnStartSeq === null || end.seq > facts.summary.lastTurnStartSeq)) {
    if (end.reason === 'error') return 'failed'
    const unread = lastSeenTurnEndSeq === null || end.seq > lastSeenTurnEndSeq
    if (end.reason === 'completed') return unread ? 'new-result' : 'idle'
    if (end.reason === 'aborted' || end.reason === 'forked') return 'idle'
    return unread ? 'needs-check' : 'idle'
  }
  return 'idle'
}
