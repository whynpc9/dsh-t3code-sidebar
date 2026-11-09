/**
 * Snooze wakes only the browser can see: approvals and questions arrive in the
 * browser's `uiSession`, not in Host facts. When one wakes a Snooze, the wake
 * must be persisted, or the task would fall back into Snoozed once the request
 * disappears.
 */
import type { TaskView } from '../contracts/schema.ts'
import { wakeReason } from '../domain/placement.ts'
import { known, type NativeState, type TaskFacts } from '../domain/types.ts'

/**
 * Compare requests by key only: the same open question can surface as the live
 * interaction or as a durable ask, and a change of source is not a new request.
 */
const byKey = (id: string): string => `request:${id.slice(id.indexOf(':') + 1)}`

export interface PendingWake {
  readonly sessionId: string
  readonly revision: number
}

export function browserObservedWakes(
  tasks: ReadonlyMap<string, TaskView>,
  factsFor: (sessionId: string) => { readonly facts: TaskFacts; readonly native: NativeState } | null,
  now: number,
): PendingWake[] {
  const wakes: PendingWake[] = []
  for (const [sessionId, view] of tasks) {
    const disposition = view.record.disposition
    if (disposition.kind !== 'snoozed') continue
    const live = factsFor(sessionId)
    if (live === null || live.native.pinned || live.native.archived) continue
    // Expiry, failures and human input are Host-detected; only new requests are browser-only.
    const pending = live.facts.pending.known
      ? known(live.facts.pending.value.map(signal => ({ ...signal, source: 'request' })))
      : live.facts.pending
    const normalized = { ...disposition, baselinePending: disposition.baselinePending.map(byKey) }
    if (wakeReason(normalized, { ...live.facts, pending, summary: view.record.activity }, now) === 'new-pending') {
      wakes.push({ sessionId, revision: view.record.revision })
    }
  }
  return wakes
}
