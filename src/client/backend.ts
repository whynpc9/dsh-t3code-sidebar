/**
 * Task-state backends.
 *
 * - `HostBackend`: the `t3Sidebar` Remote namespace (baseline + ordered deltas,
 *   revision-checked idempotent commands). Shared by all owner windows.
 * - `LocalBackend`: browser-only preview used when the Host namespace cannot be
 *   mounted (decision Q1). Same domain transitions, stored in localStorage and
 *   synchronized across tabs of this browser with BroadcastChannel. Snoozes
 *   only return while a tab is open; automatic settling is unavailable.
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'
import { REMOTE_SPEC, NAMESPACE } from '../contracts/remote.ts'
import {
  PROTOCOL_VERSION,
  type Capabilities, type CommandAction, type CommandResult, type FollowEvent, type PolicyResult, type Snapshot, type TaskView,
} from '../contracts/schema.ts'
import { reconcile, reopen, setPolicyOverride, settle, snooze, type Transition } from '../domain/commands.ts'
import {
  DEFAULT_AUTO_SETTLE_DAYS, EMPTY_ACTIVITY, emptyRecord, known,
  type NativeState, type PendingSignal, type TaskFacts, type TaskRecord, type TimePolicy,
} from '../domain/types.ts'
import { LocalRecordStore } from './local-store.ts'
import { createStore, type Store } from './store.ts'

export type BackendKind = 'host' | 'local'

export interface BackendState {
  readonly kind: BackendKind | 'connecting'
  readonly status: 'connecting' | 'ready' | 'stale'
  readonly tasks: ReadonlyMap<string, TaskView>
  readonly policy: TimePolicy
  readonly capabilities: Capabilities
  /** serverNow − Date.now() at the last baseline/delta. */
  readonly clockOffset: number
  /** Why the browser-only backend is in use. */
  readonly reason: string | null
}

export interface CommandContext {
  readonly native: NativeState
  readonly facts: TaskFacts
  readonly observedPending: readonly PendingSignal[] | null
}

export interface TaskBackend {
  readonly state: Store<BackendState>
  command(sessionId: string, action: CommandAction, context: CommandContext): Promise<CommandResult>
  setPolicy(days: number | null, keepFailures: boolean): Promise<PolicyResult>
  listTransitions(limit: number): Promise<readonly { at: number; sessionId: string; from: string; to: string; reason: string }[]>
  dispose(): void
}

const NO_CAPABILITIES: Capabilities = { hostActivity: false, sessionEvents: false, hostPending: false }
const DEFAULT_POLICY: TimePolicy = { revision: 0, autoSettleAfterDays: DEFAULT_AUTO_SETTLE_DAYS, keepUnacknowledgedFailures: false }

export const initialBackendState: BackendState = {
  kind: 'connecting',
  status: 'connecting',
  tasks: new Map(),
  policy: DEFAULT_POLICY,
  capabilities: NO_CAPABILITIES,
  clockOffset: 0,
  reason: null,
}

const commandId = (): string => globalThis.crypto.randomUUID()

// ── Host backend ─────────────────────────────────────────────────────────────

interface RemoteResult<T> { readonly ok: boolean; readonly value?: T; readonly error?: { readonly code: string; readonly message: string } }
interface T3Remote {
  getSnapshot(protocolVersion: number): Promise<RemoteResult<Snapshot>>
  follow(protocolVersion: number, signal?: AbortSignal): AsyncIterable<FollowEvent> & { dispose?: () => void }
  command(input: unknown): Promise<RemoteResult<CommandResult>>
  setPolicy(input: unknown): Promise<RemoteResult<PolicyResult>>
  listTransitions(limit: number): Promise<RemoteResult<readonly { at: number; sessionId: string; from: string; to: string; reason: string }[]>>
}

interface MountCtx {
  remote: { $mount(contribution: unknown): Promise<() => Promise<void> | void> }
  inject(deps: string[], callback: (scoped: { remote: Record<string, unknown> }) => void | (() => void)): () => void
}

const MOUNT_TIMEOUT_MS = 10_000

/**
 * Mount the Remote contribution and verify the Host answers. Resolves to the
 * backend, or rejects with a reason the caller shows before falling back.
 * The namespace service only exists after `$mount`, so it is reached through a
 * nested `inject` scope rather than the plugin's static `inject` list.
 */
export async function connectHostBackend(ctx: MountCtx, onConnectionReset: (listener: () => void) => () => void): Promise<TaskBackend> {
  const info = createTypertRemoteInfo(REMOTE_SPEC as never, z as never)
  const unmount = await ctx.remote.$mount(info)
  let release = (): void => {}
  const api = await new Promise<T3Remote>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('t3Sidebar namespace did not become available')), MOUNT_TIMEOUT_MS)
    release = ctx.inject(['remote', `remote.${NAMESPACE}`], (scoped) => {
      clearTimeout(timer)
      resolve(scoped.remote[NAMESPACE] as T3Remote)
    })
  }).catch(async (error: unknown) => {
    release()
    await unmount()
    throw error
  })
  const unmountAll = async () => { release(); await unmount() }
  const probe = await api.getSnapshot(PROTOCOL_VERSION)
  if (!probe.ok || probe.value === undefined) {
    await unmountAll()
    throw new Error(`Host t3Sidebar unavailable: ${probe.error?.code ?? 'unknown'} ${probe.error?.message ?? ''}`.trim())
  }
  return new HostBackend(api, probe.value, unmountAll, onConnectionReset)
}

class HostBackend implements TaskBackend {
  readonly state: Store<BackendState>
  private readonly abort = new AbortController()
  private epoch: string
  private streamSeq: number
  private disposed = false
  private retry = 0
  private readonly stopReset: () => void

  constructor(
    private readonly api: T3Remote,
    baseline: Snapshot,
    private readonly unmount: () => Promise<void> | void,
    onConnectionReset: (listener: () => void) => () => void,
  ) {
    this.epoch = baseline.epoch
    this.streamSeq = baseline.streamSeq
    this.state = createStore<BackendState>(this.fromSnapshot(baseline))
    this.stopReset = onConnectionReset(() => { this.markStale() })
    void this.followLoop()
  }

  private fromSnapshot(snapshot: Snapshot): BackendState {
    return {
      kind: 'host',
      status: 'ready',
      tasks: new Map(snapshot.tasks.map(task => [task.sessionId, task])),
      policy: snapshot.policy,
      capabilities: snapshot.capabilities,
      clockOffset: snapshot.serverNow - Date.now(),
      reason: null,
    }
  }

  private markStale(): void {
    const current = this.state.getSnapshot()
    if (current.status !== 'stale') this.state.set({ ...current, status: 'stale' })
  }

  private async followLoop(): Promise<void> {
    while (!this.disposed) {
      try {
        const stream = this.api.follow(PROTOCOL_VERSION, this.abort.signal)
        for await (const event of stream) {
          if (this.disposed) break
          this.retry = 0
          this.apply(event)
        }
      } catch {
        // Stream ended by a disconnect or a Host restart; a fresh baseline follows.
      }
      if (this.disposed) break
      this.markStale()
      const delay = Math.min(30_000, 500 * 2 ** this.retry++)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  private apply(event: FollowEvent): void {
    if (event.kind === 'baseline') {
      this.epoch = event.snapshot.epoch
      this.streamSeq = event.snapshot.streamSeq
      this.state.set(this.fromSnapshot(event.snapshot))
      return
    }
    // Deltas must be contiguous within one epoch; anything else waits for a new baseline.
    if (event.epoch !== this.epoch || event.streamSeq !== this.streamSeq + 1) {
      if (event.epoch === this.epoch && event.streamSeq <= this.streamSeq) return
      this.markStale()
      return
    }
    this.streamSeq = event.streamSeq
    const current = this.state.getSnapshot()
    const tasks = new Map(current.tasks)
    for (const task of event.tasks) tasks.set(task.sessionId, task)
    this.state.set({
      ...current,
      status: 'ready',
      tasks,
      policy: event.policy ?? current.policy,
      clockOffset: event.serverNow - Date.now(),
    })
  }

  private merge(task: TaskView): void {
    const current = this.state.getSnapshot()
    const existing = current.tasks.get(task.sessionId)
    if (existing !== undefined && existing.record.revision > task.record.revision) return
    const tasks = new Map(current.tasks)
    tasks.set(task.sessionId, task)
    this.state.set({ ...current, tasks })
  }

  async command(sessionId: string, action: CommandAction, context: CommandContext): Promise<CommandResult> {
    const expectedRevision = this.state.getSnapshot().tasks.get(sessionId)?.record.revision ?? 0
    const result = await this.api.command({
      protocolVersion: PROTOCOL_VERSION,
      commandId: commandId(),
      sessionId,
      expectedRevision,
      action,
      observedPending: context.observedPending === null ? null : [...context.observedPending],
    })
    if (!result.ok || result.value === undefined) {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: result.error?.message ?? 'remote call failed', task: null }
    }
    if (result.value.task !== null) this.merge(result.value.task)
    return result.value
  }

  async setPolicy(days: number | null, keepFailures: boolean): Promise<PolicyResult> {
    const current = this.state.getSnapshot()
    const result = await this.api.setPolicy({
      protocolVersion: PROTOCOL_VERSION,
      expectedRevision: current.policy.revision,
      autoSettleAfterDays: days,
      keepUnacknowledgedFailures: keepFailures,
    })
    if (!result.ok || result.value === undefined) {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: result.error?.message ?? 'remote call failed', policy: current.policy }
    }
    this.state.set({ ...this.state.getSnapshot(), policy: result.value.policy })
    return result.value
  }

  async listTransitions(limit: number) {
    const result = await this.api.listTransitions(limit)
    return result.ok && result.value !== undefined ? result.value : []
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    this.stopReset()
    void this.unmount()
  }
}

// ── Browser-only backend ────────────────────────────────────────────────────

const CHANNEL = 't3-sidebar:v1'

export class LocalBackend implements TaskBackend {
  readonly state: Store<BackendState>
  private records: Map<string, TaskRecord>
  private readonly channel: BroadcastChannel | null
  private readonly timer: ReturnType<typeof setInterval>
  private readonly onStorage = (event: StorageEvent) => {
    if (LocalRecordStore.owns(event.key)) this.reload()
  }

  constructor(
    reason: string,
    private readonly factsFor: (sessionId: string) => { facts: TaskFacts; native: NativeState } | null,
    private readonly store = new LocalRecordStore(),
  ) {
    this.records = store.readAll()
    this.state = createStore<BackendState>({
      kind: 'local',
      status: 'ready',
      tasks: this.views(),
      policy: { revision: 0, autoSettleAfterDays: null, keepUnacknowledgedFailures: false },
      capabilities: NO_CAPABILITIES,
      clockOffset: 0,
      reason,
    })
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
    if (this.channel !== null) this.channel.onmessage = () => { this.reload() }
    globalThis.addEventListener?.('storage', this.onStorage)
    this.timer = setInterval(() => { void this.tick() }, 15_000)
  }

  private reload(): void {
    this.records = this.store.readAll()
    this.publish()
  }

  /** After a store write: refresh from the store (which keeps unpersisted records), render, tell other tabs. */
  private afterWrite(_sessionId: string, _written: TaskRecord | null): void {
    this.records = this.store.readAll()
    this.channel?.postMessage('changed')
    this.publish()
  }

  private views(): Map<string, TaskView> {
    return new Map([...this.records].map(([id, record]) => [id, {
      sessionId: id, record, activity: null, autoSettleDeadline: null, autoSettleSkip: 'policy-off',
    }]))
  }

  private publish(): void {
    this.state.set({ ...this.state.getSnapshot(), tasks: this.views() })
  }

  /** Materialize Snooze expiry and new-activity wakes while a tab is open. */
  private async tick(): Promise<void> {
    for (const [id, cached] of this.records) {
      if (cached.disposition.kind === 'normal') continue
      const live = this.factsFor(id)
      if (live === null) continue
      const written = await this.store.update(id, current =>
        current === undefined ? null : reconcile(current, { ...live.facts, summary: current.activity }, live.native, Date.now()))
      if (written !== null) this.afterWrite(id, written)
    }
  }

  /** Record a browser-observed turn boundary so Settled tasks reopen on new work. */
  observeTurn(sessionId: string, running: boolean): void {
    if (!this.records.has(sessionId)) return
    const now = Date.now()
    void this.store.update(sessionId, (current) => {
      if (current === undefined) return null
      const summary = current.activity
      const seq = Math.max(summary.lastTurnStartSeq ?? 0, summary.lastTurnEnd?.seq ?? 0) + 1
      const activity = running
        ? { ...summary, lastTurnStartSeq: seq, lastTurnStartAt: now }
        // A stopped running flag cannot tell success from failure or
        // cancellation; record the outcome as unknown ("needs a look").
        : { ...summary, lastTurnEnd: { seq, at: now, reason: 'unknown' } }
      return { ...current, activity }
    }).then((written) => {
      this.afterWrite(sessionId, written)
      void this.tick()
    })
  }

  async command(sessionId: string, action: CommandAction, context: CommandContext): Promise<CommandResult> {
    const now = Date.now()
    const view = (record: TaskRecord): TaskView => ({ sessionId, record, activity: null, autoSettleDeadline: null, autoSettleSkip: 'policy-off' })
    let outcome: Transition | undefined
    let base: TaskRecord | undefined
    // Applied to the record as stored now (inside the cross-tab lock), never to a cached copy.
    const written = await this.store.update(sessionId, (stored) => {
      const current = stored ?? { ...emptyRecord(sessionId, now), activity: EMPTY_ACTIVITY }
      base = current
      const facts: TaskFacts = {
        ...context.facts,
        pending: context.observedPending === null ? context.facts.pending : known(context.observedPending),
        summary: current.activity,
      }
      switch (action.kind) {
        case 'snooze': outcome = snooze(current, facts, context.native, action.until, now); break
        case 'settle': outcome = settle(current, facts, context.native, now); break
        case 'reopen': outcome = reopen(current, now); break
        case 'policy-override': outcome = setPolicyOverride(current, action.override, now); break
      }
      return outcome.ok ? outcome.record : null
    })
    if (outcome === undefined || base === undefined) {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'local store unavailable', task: null }
    }
    if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message, task: view(base) }
    this.afterWrite(sessionId, written)
    return { ok: true, task: view(outcome.record), dataRevision: 0, replayed: false }
  }

  async setPolicy(): Promise<PolicyResult> {
    return { ok: false, code: 'UNSUPPORTED_HOST', message: 'automatic settling needs the Host service', policy: this.state.getSnapshot().policy }
  }

  async listTransitions() { return [] }

  dispose(): void {
    clearInterval(this.timer)
    this.channel?.close()
    globalThis.removeEventListener?.('storage', this.onStorage)
  }
}
