/**
 * Section ordering (product spec §4.5). No key is driven by token-level
 * updates: only semantic times (input, turn start/end, wake, settle).
 */
import type { Placement, TaskFacts, TaskRecord } from './types.ts'

export interface SortInput {
  readonly sessionId: string
  readonly facts: TaskFacts
  readonly record: TaskRecord | undefined
  /** Index in the Host pin set (most recently pinned first); -1 when unpinned. */
  readonly pinIndex: number
  /** List activity time, used only when no semantic time is known (cold rows). */
  readonly fallbackAt: number
}

const maxOf = (...values: readonly (number | null | undefined)[]): number => {
  let best = Number.NEGATIVE_INFINITY
  for (const value of values) if (typeof value === 'number' && value > best) best = value
  return best
}

/** Time the session last needed the user's eyes: a return event or human activity. */
export function activeKey(input: SortInput): number {
  const summary = input.facts.summary
  const semantic = maxOf(
    summary.lastTurnEnd?.at,
    summary.lastUserInputAt,
    input.record?.lastSnoozeWakeAt,
  )
  return semantic === Number.NEGATIVE_INFINITY ? input.fallbackAt : semantic
}

const byIdAsc = (left: SortInput, right: SortInput): number =>
  left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0

/** Comparator for one section; ties fall back to the stable session id. */
export function comparatorFor(placement: Placement): (left: SortInput, right: SortInput) => number {
  switch (placement) {
    case 'pinned':
      return (left, right) => (left.pinIndex - right.pinIndex) || byIdAsc(left, right)
    case 'active':
      return (left, right) => (activeKey(right) - activeKey(left)) || byIdAsc(left, right)
    case 'working':
      return (left, right) =>
        (maxOf(right.facts.summary.lastTurnStartAt, right.fallbackAt) - maxOf(left.facts.summary.lastTurnStartAt, left.fallbackAt))
        || byIdAsc(left, right)
    case 'snoozed': {
      const until = (input: SortInput): number =>
        input.record?.disposition.kind === 'snoozed' ? input.record.disposition.until : Number.POSITIVE_INFINITY
      return (left, right) => (until(left) - until(right)) || byIdAsc(left, right)
    }
    case 'settled': {
      const entered = (input: SortInput): number =>
        input.record?.disposition.kind === 'settled' ? input.record.disposition.enteredAt : 0
      return (left, right) => (entered(right) - entered(left)) || byIdAsc(left, right)
    }
  }
}
