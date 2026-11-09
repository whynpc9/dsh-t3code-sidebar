/**
 * Pure state transitions for task records. The Host service (and the
 * browser-only fallback) wrap these in a serial, CAS-checked, idempotent
 * command queue; nothing here touches storage.
 */
import { pendingId, reopenReason, wakeReason } from './placement.ts'
import { validateSnoozeUntil } from './time.ts'
import type {
  ActivitySummary, NativeState, SessionPolicyOverride, TaskFacts, TaskRecord, TurnEndKind,
} from './types.ts'

/** Stable business error codes; clients never parse messages. */
export type TaskErrorCode =
  | 'UNSUPPORTED_HOST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SESSION_ACTIVE'
  | 'PENDING_APPROVAL'
  | 'PINNED'
  | 'ARCHIVED'
  | 'PENDING_INPUT'
  | 'BASELINE_PENDING'
  | 'INVALID_TIME'
  | 'STORAGE_UNAVAILABLE'
  | 'PROTOCOL_MISMATCH'

export type Transition =
  | { readonly ok: true; readonly record: TaskRecord }
  | { readonly ok: false; readonly code: TaskErrorCode; readonly message: string }

const fail = (code: TaskErrorCode, message: string): Transition => ({ ok: false, code, message })
const next = (record: TaskRecord, patch: Partial<TaskRecord>): TaskRecord =>
  ({ ...record, ...patch, revision: record.revision + 1 })

const pendingIds = (facts: TaskFacts): readonly string[] =>
  facts.pending.known ? facts.pending.value.map(pendingId) : []

const hasApproval = (facts: TaskFacts): boolean =>
  facts.pending.known && facts.pending.value.some(signal => signal.kind.includes('approval'))

/**
 * Snooze: allowed while running (it only delays display), refused for pinned
 * or archived sessions, unresolved approvals, unknown baselines and bad times.
 */
export function snooze(
  record: TaskRecord, facts: TaskFacts, native: NativeState, until: number, now: number,
): Transition {
  if (native.archived) return fail('ARCHIVED', 'archived sessions cannot be snoozed')
  if (native.pinned) return fail('PINNED', 'unpin the session before snoozing it')
  const timeError = validateSnoozeUntil(until, now)
  if (timeError !== null) return fail('INVALID_TIME', `snooze deadline is ${timeError}`)
  if (!facts.pending.known) return fail('BASELINE_PENDING', 'pending interactions are not known yet')
  if (hasApproval(facts)) return fail('PENDING_APPROVAL', 'resolve the approval before snoozing')
  return {
    ok: true,
    record: next(record, {
      disposition: {
        kind: 'snoozed',
        until,
        setAt: now,
        baselinePending: pendingIds(facts),
        baselineTurnEndSeq: record.activity.lastTurnEnd?.seq ?? null,
        baselineUserInputAt: record.activity.lastUserInputAt,
      },
    }),
  }
}

/** Manual settle: only for known-idle sessions with nothing awaiting the user. */
export function settle(record: TaskRecord, facts: TaskFacts, native: NativeState, now: number): Transition {
  if (native.archived) return fail('ARCHIVED', 'archived sessions cannot be settled')
  if (native.pinned) return fail('PINNED', 'unpin the session before settling it')
  if (!facts.running.known || !facts.activity.known || !facts.pending.known) {
    return fail('BASELINE_PENDING', 'session state is still synchronizing')
  }
  if (facts.running.value || facts.activity.value.length > 0) return fail('SESSION_ACTIVE', 'the session still has running work')
  if (hasApproval(facts)) return fail('PENDING_APPROVAL', 'resolve the approval before settling')
  if (facts.pending.value.length > 0) return fail('PENDING_INPUT', 'answer the pending question before settling')
  return {
    ok: true,
    record: next(record, {
      disposition: {
        kind: 'settled',
        reason: 'manual',
        enteredAt: now,
        baselineTurnStartSeq: record.activity.lastTurnStartSeq,
        baselineUserInputAt: record.activity.lastUserInputAt,
        baselinePending: pendingIds(facts),
      },
      autoSettleHold: null,
    }),
  }
}

/** Automatic settle commit; the caller has already run `decideAutoSettle`. */
export function autoSettle(
  record: TaskRecord, facts: TaskFacts, now: number, audit: { anchorAt: number; deadline: number; policyRevision: number },
): TaskRecord {
  return next(record, {
    disposition: {
      kind: 'settled',
      reason: 'idle-timeout',
      enteredAt: now,
      baselineTurnStartSeq: record.activity.lastTurnStartSeq,
      baselineUserInputAt: record.activity.lastUserInputAt,
      baselinePending: pendingIds(facts),
      ...audit,
    },
  })
}

/**
 * Reopen / wake now. Waking a Snooze restarts the inactivity window; reopening
 * a Settled task adds a hold so the next sweep does not settle it again.
 */
export function reopen(record: TaskRecord, now: number): Transition {
  const disposition = record.disposition
  if (disposition.kind === 'normal') return { ok: true, record: next(record, {}) }
  if (disposition.kind === 'snoozed') {
    return { ok: true, record: next(record, { disposition: { kind: 'normal' }, lastSnoozeWakeAt: now }) }
  }
  return {
    ok: true,
    record: next(record, {
      disposition: { kind: 'normal' },
      autoSettleHold: {
        baselineUserInputAt: record.activity.lastUserInputAt,
        baselineTurnStartSeq: record.activity.lastTurnStartSeq,
      },
    }),
  }
}

export function setPolicyOverride(record: TaskRecord, override: SessionPolicyOverride, now: number): Transition {
  if (record.policyOverride === override) return { ok: true, record: next(record, {}) }
  // Re-enabling starts a fresh grace window so the session is not settled at once.
  return { ok: true, record: next(record, { policyOverride: override, policyEligibleSince: override === 'inherit' ? now : record.policyEligibleSince }) }
}

/** Committed session event, reduced to the fields the summary folds. */
export type FoldableEvent =
  | { readonly type: 'user/message'; readonly seq: number; readonly time: number; readonly human: boolean }
  | { readonly type: 'turn/start'; readonly seq: number; readonly time: number }
  | { readonly type: 'turn/end'; readonly seq: number; readonly time: number; readonly reason: TurnEndKind }

/** Fold one committed event into the activity summary (idempotent for replays). */
export function foldActivity(summary: ActivitySummary, event: FoldableEvent): ActivitySummary {
  switch (event.type) {
    case 'user/message':
      if (!event.human) return summary
      return summary.lastUserInputAt !== null && summary.lastUserInputAt >= event.time
        ? summary
        : { ...summary, lastUserInputAt: event.time }
    case 'turn/start':
      if (summary.lastTurnStartSeq !== null && summary.lastTurnStartSeq >= event.seq) return summary
      return { ...summary, lastTurnStartSeq: event.seq, lastTurnStartAt: event.time }
    case 'turn/end':
      // A fork seed closes an inherited turn; it is not a new result.
      if (event.reason === 'forked') return summary
      if (summary.lastTurnEnd !== null && summary.lastTurnEnd.seq >= event.seq) return summary
      return { ...summary, lastTurnEnd: { seq: event.seq, at: event.time, reason: event.reason } }
  }
}

/**
 * Durable reconciliation after facts change: materialize Snooze wakes, reopen
 * Settled tasks on new activity, release reopen holds. Returns `null` when the
 * record is unchanged. Archived sessions are frozen until restored.
 */
export function reconcile(record: TaskRecord, facts: TaskFacts, native: NativeState, now: number): TaskRecord | null {
  if (native.archived) return null
  let changed: Partial<TaskRecord> | null = null
  const disposition = record.disposition
  if (disposition.kind === 'snoozed' && !native.pinned) {
    const reason = wakeReason(disposition, facts, now)
    if (reason !== null) {
      changed = { disposition: { kind: 'normal' }, lastSnoozeWakeAt: reason === 'expired' ? disposition.until : now }
    }
  } else if (disposition.kind === 'settled' && !native.pinned) {
    if (reopenReason(disposition, facts) !== null) changed = { disposition: { kind: 'normal' } }
  }
  const hold = record.autoSettleHold
  if (hold !== null) {
    const input = facts.summary.lastUserInputAt
    const start = facts.summary.lastTurnStartSeq
    const fresh = (input !== null && (hold.baselineUserInputAt === null || input > hold.baselineUserInputAt))
      || (start !== null && (hold.baselineTurnStartSeq === null || start > hold.baselineTurnStartSeq))
    if (fresh) changed = { ...changed, autoSettleHold: null }
  }
  return changed === null ? null : next(record, changed)
}
