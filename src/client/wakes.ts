/**
 * Snooze wakes only the browser can see: approvals and questions arrive in the
 * browser's `uiSession`, not in Host facts. When one wakes a Snooze, the wake
 * must be persisted, or the task would fall back into Snoozed once the request
 * disappears.
 */
import type { TaskView } from '../contracts/schema.ts'
import { wakeReason } from '../domain/placement.ts'
import type { NativeState, TaskFacts } from '../domain/types.ts'

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
    // Same rule as placement (key-only request identity), so display and durable state agree.
    if (wakeReason(disposition, { ...live.facts, summary: view.record.activity }, now) === 'new-pending') {
      wakes.push({ sessionId, revision: view.record.revision })
    }
  }
  return wakes
}
