/**
 * Snooze wakes only the browser can see: approvals and questions arrive in the
 * browser's `uiSession`, not in Host facts. When one wakes a Snooze, the wake
 * must be persisted, or the task would fall back into Snoozed once the request
 * disappears.
 */
import type { TaskView } from '../contracts/schema.ts'
import type { CommandOutcome } from './backend.ts'
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

const keyOf = (wake: PendingWake): string => `${wake.sessionId}:${wake.revision}`

/**
 * Outcomes worth retrying: the wake may succeed once storage/transport
 * recovers. A retry after UNCONFIRMED is safe: it is revision-checked, so if
 * the lost attempt was committed the retry is refused (and the record's new
 * revision no longer asks for this wake).
 */
const TRANSIENT = new Set(['STORAGE_UNAVAILABLE', 'BASELINE_PENDING', 'UNCONFIRMED'])

export type Scheduler = (task: () => void, delayMs: number) => () => void

/**
 * Sends each browser-observed wake once per record revision. Persisted wakes
 * and definitive rejections (the record changed, or the session was pinned or
 * archived) stay deduplicated; transient failures are forgotten and retried
 * with backoff (1 s doubling, capped at 30 s).
 */
export class WakeDispatcher {
  private readonly settled = new Set<string>()
  private readonly inFlight = new Set<string>()
  private readonly failures = new Map<string, number>()
  private readonly timers = new Map<string, () => void>()
  private latest: readonly PendingWake[] = []
  private disposed = false

  constructor(
    private readonly send: (wake: PendingWake) => Promise<CommandOutcome>,
    private readonly schedule: Scheduler = (task, delayMs) => { const id = setTimeout(task, delayMs); return () => clearTimeout(id) },
  ) {}

  /** Replace the set of wanted wakes and send any that are not yet handled. */
  sync(wakes: readonly PendingWake[]): void {
    this.latest = wakes
    for (const wake of wakes) this.dispatch(wake)
  }

  private dispatch(wake: PendingWake): void {
    const key = keyOf(wake)
    if (this.disposed || this.settled.has(key) || this.inFlight.has(key) || this.timers.has(key)) return
    this.inFlight.add(key)
    void this.send(wake).then(
      result => this.finish(key, result.ok || !TRANSIENT.has(result.code)),
      () => this.finish(key, false),
    )
  }

  private finish(key: string, final: boolean): void {
    this.inFlight.delete(key)
    if (this.disposed) return
    if (final) {
      this.settled.add(key)
      this.failures.delete(key)
      return
    }
    const failures = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, failures)
    const delay = Math.min(1000 * 2 ** (failures - 1), 30_000)
    this.timers.set(key, this.schedule(() => {
      this.timers.delete(key)
      // Retry only if the wake is still wanted for the same record revision;
      // the wanted set itself is left untouched for the other sessions.
      const wanted = this.latest.find(wake => keyOf(wake) === key)
      if (wanted !== undefined) this.dispatch(wanted)
    }, delay))
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.timers.values()) cancel()
    this.timers.clear()
  }
}
