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

/**
 * Shared acknowledgement of a result (time-policy spec §3, `acknowledgeResult`):
 * only a result the record has folded can be acknowledged, and the mark never
 * moves backwards (acknowledging an older result again is a no-op).
 */
export function acknowledgeResult(record: TaskRecord, turnEndSeq: number): Transition {
  const end = record.activity.lastTurnEnd
  if (end === null || turnEndSeq > end.seq) return fail('NOT_FOUND', 'no such result yet')
  const current = record.resultAcknowledgedSeq
  return { ok: true, record: next(record, current !== null && current >= turnEndSeq ? {} : { resultAcknowledgedSeq: turnEndSeq }) }
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
 * Undo an automatic settle that a just-folded result says was premature: the
 * turn was still ending while the sweep judged the session (any later turn
 * start reopens a settled task anyway), and an active keep protection holds
 * that result until it is acknowledged. Manual settles are never undone here.
 * Returns null when nothing changes.
 */
export function releaseHeldAutoSettle(
  record: TaskRecord,
  held: (record: TaskRecord) => boolean,
): TaskRecord | null {
  const disposition = record.disposition
  if (disposition.kind !== 'settled' || disposition.reason !== 'idle-timeout') return null
  return held(record) ? { ...record, disposition: { kind: 'normal' } } : null
}

/**
 * Merge a session's replayed history into its record. A parking (Snooze or
 * Settle) accepted while the summary still missed older events keeps its
 * meaning: replayed events that predate the parking advance its baselines, so
 * only events after it can wake or reopen the task. A reopen hold is extended
 * over every replayed event (conservative: it only keeps the hold longer).
 * Returns the record unchanged when the replay adds nothing.
 */
export function mergeHistory(record: TaskRecord, events: readonly FoldableEvent[]): TaskRecord {
  let activity = record.activity
  for (const event of events) activity = foldActivity(activity, event)
  if (activity === record.activity) return record
  const latest = (current: number | null, values: readonly number[]): number | null =>
    values.reduce<number | null>((best, value) => (best === null || value > best ? value : best), current)
  const inputs = (before: number) => events.filter(e => e.type === 'user/message' && e.human && e.time < before).map(e => e.time)
  const starts = (before: number) => events.filter(e => e.type === 'turn/start' && e.time < before).map(e => e.seq)
  const ends = (before: number) => events.filter(e => e.type === 'turn/end' && e.reason !== 'forked' && e.time < before).map(e => e.seq)
  let disposition = record.disposition
  if (disposition.kind === 'settled') {
    disposition = {
      ...disposition,
      baselineUserInputAt: latest(disposition.baselineUserInputAt, inputs(disposition.enteredAt)),
      baselineTurnStartSeq: latest(disposition.baselineTurnStartSeq, starts(disposition.enteredAt)),
    }
  } else if (disposition.kind === 'snoozed') {
    disposition = {
      ...disposition,
      baselineUserInputAt: latest(disposition.baselineUserInputAt, inputs(disposition.setAt)),
      baselineTurnEndSeq: latest(disposition.baselineTurnEndSeq, ends(disposition.setAt)),
    }
  }
  const hold = record.autoSettleHold === null ? null : {
    baselineUserInputAt: latest(record.autoSettleHold.baselineUserInputAt, inputs(Number.POSITIVE_INFINITY)),
    baselineTurnStartSeq: latest(record.autoSettleHold.baselineTurnStartSeq, starts(Number.POSITIVE_INFINITY)),
  }
  return next(record, { activity, disposition, autoSettleHold: hold })
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
