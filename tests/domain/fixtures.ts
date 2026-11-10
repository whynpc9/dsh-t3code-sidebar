import { EMPTY_ACTIVITY, emptyRecord, known, type ActivitySummary, type PendingSignal, type TaskFacts, type TaskRecord } from '../../src/domain/types.ts'

export const T0 = Date.UTC(2026, 10, 1, 12)

export function facts(patch: {
  running?: boolean | 'unknown'
  pending?: readonly PendingSignal[] | 'unknown'
  activity?: readonly string[] | 'unknown'
  summary?: Partial<ActivitySummary>
} = {}): TaskFacts {
  const running = patch.running ?? false
  const pending = patch.pending ?? []
  const activity = patch.activity ?? (running === true ? ['turn'] : [])
  return {
    running: running === 'unknown' ? { known: false } : known(running),
    pending: pending === 'unknown' ? { known: false } : known(pending),
    activity: activity === 'unknown' ? { known: false } : known(activity),
    summary: { ...EMPTY_ACTIVITY, ...patch.summary },
  }
}

export function record(patch: Partial<TaskRecord> = {}): TaskRecord {
  return { ...emptyRecord('s1', T0), ...patch }
}

export const approval: PendingSignal = { source: 'approval', key: 'a1', kind: 'approval' }
export const question: PendingSignal = { source: 'userQuestions', key: 'q1', kind: 'user-question' }
export const native = { pinned: false, archived: false }
