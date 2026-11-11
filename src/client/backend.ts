/**
 * Task-state backends.
 *
 * - `HostBackend`: the `t3Sidebar` Remote namespace (baseline + ordered deltas,
 *   revision-checked idempotent commands). Shared by all owner windows.
 * - `LocalBackend`: browser-only preview used when the Host namespace is
 *   missing, incompatible or refuses this window (decision Q1). Same domain
 *   transitions, stored in localStorage and synchronized across tabs of this
 *   browser with BroadcastChannel. Snoozes only return while a tab is open;
 *   automatic settling is unavailable.
 *
 * Generations (HostBackend): every follow subscription has a generation
 * number. A connection reset, an epoch change, a sequence gap, the end of the
 * stream, a namespace replacement and dispose all start a new generation.
 * Events of an older stream and replies of RPCs sent in an older generation
 * never touch the current state, and the backend is `ready` (accepting
 * writes) only after a baseline of the current generation arrived.
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'
import { NAMESPACE, PROTOCOL_MISMATCH_CODE, REMOTE_SPEC } from '../contracts/remote.ts'
import {
  PROTOCOL_VERSION,
  type Capabilities, type CommandAction, type CommandInput, type CommandResult, type FollowEvent, type PolicyResult,
  type Snapshot, type TaskView,
} from '../contracts/schema.ts'
import { reconcile, reopen, setPolicyOverride, settle, snooze, type Transition } from '../domain/commands.ts'
import {
  DEFAULT_AUTO_SETTLE_DAYS, EMPTY_ACTIVITY, emptyRecord, known,
  type NativeState, type PendingSignal, type TaskFacts, type TaskRecord, type TimePolicy,
} from '../domain/types.ts'
import { LocalRecordStore } from './local-store.ts'
import { createStore, type Store } from './store.ts'

export type BackendKind = 'host' | 'local'

/**
 * Why the Host task service is not in use:
 * - `missing`: the namespace never appeared (Host half off or not installed);
 * - `incompatible`: the Host speaks another protocol or rejects our requests;
 * - `forbidden`: the Host refuses this window (not the owner);
 * - `transient`: a disconnect or Host failure; the Host is retried, never
 *   replaced by the browser-only preview.
 */
export type HostFailure = 'missing' | 'incompatible' | 'forbidden' | 'transient'

export interface BackendState {
  readonly kind: BackendKind | 'connecting'
  readonly status: 'connecting' | 'ready' | 'stale'
  readonly tasks: ReadonlyMap<string, TaskView>
  readonly policy: TimePolicy
  readonly capabilities: Capabilities
  /** serverNow − Date.now() at the last baseline/delta. */
  readonly clockOffset: number
  /** Why the browser-only backend is in use, or why connecting is being retried. */
  readonly reason: string | null
  readonly failure: HostFailure | null
}

export interface CommandContext {
  readonly native: NativeState
  readonly facts: TaskFacts
  readonly observedPending: readonly PendingSignal[] | null
  /**
   * Automatic (not user-initiated) command whose caller retries on its own:
   * a lost reply is returned as UNCONFIRMED but not tracked for recovery.
   */
  readonly background?: boolean
}

/**
 * Client-only outcome: the request may or may not have been committed (the
 * reply was lost). The backend finds out after the next baseline and reports
 * the result through `onRecovery`.
 */
interface Unconfirmed { readonly ok: false; readonly code: 'UNCONFIRMED'; readonly message: string }
export type CommandOutcome = CommandResult | (Unconfirmed & { readonly task: null })
export type PolicyOutcome = PolicyResult | (Unconfirmed & { readonly policy: TimePolicy })

/** Result of an operation whose reply was lost, learned after reconnecting. */
export interface RecoveryNotice {
  readonly kind: 'command' | 'policy'
  /**
   * - `committed`: the operation took effect (originally or on the retry);
   * - `not-applied`: it did not take effect (`code` says why for commands);
   * - `superseded`: the policy was changed by someone else meanwhile;
   * - `gave-up`: still unconfirmed after repeated retries.
   */
  readonly outcome: 'committed' | 'not-applied' | 'superseded' | 'gave-up'
  readonly sessionId?: string
  readonly code?: string
}

export interface TaskBackend {
  readonly state: Store<BackendState>
  command(sessionId: string, action: CommandAction, context: CommandContext): Promise<CommandOutcome>
  setPolicy(days: number | null, keepFailures: boolean): Promise<PolicyOutcome>
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
  failure: null,
}

const newCommandId = (): string => globalThis.crypto.randomUUID()

// ── Host backend ─────────────────────────────────────────────────────────────

interface RemoteFailureLike { readonly code?: string; readonly message?: string }
export interface RemoteResult<T> { readonly ok: boolean; readonly value?: T; readonly error?: RemoteFailureLike }
export type FollowStream = AsyncIterable<FollowEvent> & { dispose?: () => void }
export interface T3Remote {
  getSnapshot(protocolVersion: number): Promise<RemoteResult<Snapshot>>
  follow(protocolVersion: number, signal?: AbortSignal): FollowStream
  command(input: unknown): Promise<RemoteResult<CommandResult>>
  setPolicy(input: unknown): Promise<RemoteResult<PolicyResult>>
  listTransitions(limit: number): Promise<RemoteResult<readonly { at: number; sessionId: string; from: string; to: string; reason: string }[]>>
}

/** `ctx.inject` returns a cordis Fiber (disposed with `.dispose()`); older hosts returned a disposer. */
type InjectHandle = (() => unknown) | { dispose(): unknown }

export interface MountCtx {
  remote: { $mount(contribution: unknown): Promise<() => Promise<void> | void> }
  inject(deps: string[], callback: (scoped: { remote: Record<string, unknown> }) => void | (() => void)): InjectHandle
}

export interface HostBackendOptions {
  /** Cancels a connection attempt; once aborted no resource survives and the promise rejects. */
  readonly signal?: AbortSignal
  /** Subscribe to transport resets (`connection/reset`); returns the unsubscribe. */
  readonly onConnectionReset: (listener: () => void) => () => void
  /** Results of operations whose replies were lost. */
  readonly onRecovery?: (notice: RecoveryNotice) => void
  /** Delay before resubscribing after `attempt` consecutive failures (tests shorten it). */
  readonly retryDelay?: (attempt: number) => number
  readonly mountTimeoutMs?: number
}

export class HostConnectError extends Error {
  constructor(readonly failure: HostFailure, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HostConnectError'
  }
}

/** Thrown by `connectHostBackend` when its signal aborted; callers ignore it. */
export class ConnectAbortedError extends Error {
  constructor() {
    super('connection attempt cancelled')
    this.name = 'ConnectAbortedError'
  }
}

/**
 * Classify a Remote failure carried by a `RemoteResult` or thrown by the
 * transport. The Web transport reports an HTTP answer as `gateway/internal`
 * with "transport failure for /api/<ns>/<method>: HTTP <status>"; e.g. the
 * Host half being off is an HTTP 404 (verified on dsh 0.2.2-rc.1 Linux Web).
 * Network errors and 5xx answers stay transient.
 */
export function classifyRemoteFailure(error: RemoteFailureLike | undefined): HostFailure {
  const code = error?.code ?? ''
  if (code === PROTOCOL_MISMATCH_CODE || code === 'gateway/bad-request') return 'incompatible'
  if (/forbidden|unauthori[sz]ed|denied|permission|principal/i.test(code)) return 'forbidden'
  if (/not-found|unknown-(method|namespace|service)|no-such/i.test(code)) return 'missing'
  const status = Number(/\bHTTP (\d{3})\b/.exec(error?.message ?? '')?.[1] ?? 0)
  if (status === 404 || status === 405 || status === 501) return 'missing'
  if (status === 401 || status === 403) return 'forbidden'
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'incompatible'
  return 'transient'
}

const describeFailure = (error: RemoteFailureLike | undefined): string =>
  `${error?.code ?? 'unknown'} ${error?.message ?? ''}`.trim()

/** Error code for a request the Host refused before dispatch (certainly not applied), or null if the outcome is unknown. */
function refusalCode(error: RemoteFailureLike | undefined): 'PROTOCOL_MISMATCH' | 'FORBIDDEN' | 'UNSUPPORTED_HOST' | null {
  switch (classifyRemoteFailure(error)) {
    case 'incompatible': return 'PROTOCOL_MISMATCH'
    case 'forbidden': return 'FORBIDDEN'
    case 'missing': return 'UNSUPPORTED_HOST'
    case 'transient': return null
  }
}

const MOUNT_TIMEOUT_MS = 10_000
const MAX_RECOVERY_ATTEMPTS = 5
export const defaultRetryDelay = (attempt: number): number => Math.min(30_000, 500 * 2 ** attempt)

/**
 * Mount the Remote contribution and verify the Host answers. Resolves to the
 * backend; otherwise every resource acquired so far (mount, inject scope) is
 * released and the promise rejects with a `HostConnectError` (or
 * `ConnectAbortedError` when `options.signal` aborted). The namespace service
 * only exists after `$mount`, so it is reached through a nested `inject` scope
 * rather than the plugin's static `inject` list; that scope stays alive with
 * the backend so a replaced or removed namespace reaches it.
 */
export async function connectHostBackend(ctx: MountCtx, options: HostBackendOptions): Promise<HostBackend> {
  const { signal } = options
  const releases: (() => unknown)[] = []
  const releaseAll = async (): Promise<void> => {
    for (const release of releases.splice(0).reverse()) {
      try { await release() } catch (error) { console.warn('[dsh-t3code-sidebar] cleanup failed:', error) }
    }
  }
  const checkAborted = (): void => { if (signal?.aborted) throw new ConnectAbortedError() }
  // Namespace changes after the first resolution are forwarded to the backend.
  let backend: HostBackend | undefined
  let latest: T3Remote | null = null
  try {
    checkAborted()
    const info = createTypertRemoteInfo(REMOTE_SPEC as never, z as never)
    let unmount: (() => unknown) | undefined
    try {
      unmount = await ctx.remote.$mount(info)
    } catch (error) {
      throw new HostConnectError(classifyRemoteFailure(error as RemoteFailureLike), `Remote mount failed: ${describeFailure(error as RemoteFailureLike)}`, { cause: error })
    }
    releases.push(unmount)
    checkAborted()

    const api = await new Promise<T3Remote>((resolve, reject) => {
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        action()
      }
      const onAbort = () => finish(() => reject(new ConnectAbortedError()))
      const timer = setTimeout(() => finish(() => reject(new HostConnectError('missing', 't3Sidebar namespace did not become available'))),
        options.mountTimeoutMs ?? MOUNT_TIMEOUT_MS)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const handle = ctx.inject(['remote', `remote.${NAMESPACE}`], (scoped) => {
          latest = scoped.remote[NAMESPACE] as T3Remote
          if (!settled) finish(() => resolve(latest as T3Remote))
          else backend?.replaceApi(latest)
          // Runs when the namespace service is removed or replaced.
          return () => { latest = null; backend?.replaceApi(null) }
        })
        releases.push(typeof handle === 'function' ? handle : () => handle.dispose())
      } catch (error) {
        finish(() => reject(error))
      }
    })
    checkAborted()

    let probe: RemoteResult<Snapshot>
    try {
      probe = await api.getSnapshot(PROTOCOL_VERSION)
    } catch (error) {
      throw new HostConnectError(classifyRemoteFailure(error as RemoteFailureLike), `Host t3Sidebar unavailable: ${describeFailure(error as RemoteFailureLike)}`, { cause: error })
    }
    checkAborted()
    if (!probe.ok || probe.value === undefined) {
      throw new HostConnectError(classifyRemoteFailure(probe.error), `Host t3Sidebar unavailable: ${describeFailure(probe.error)}`)
    }
    const owned = releases.splice(0)
    backend = new HostBackend(api, probe.value, async () => {
      for (const release of owned.reverse()) {
        try { await release() } catch (error) { console.warn('[dsh-t3code-sidebar] cleanup failed:', error) }
      }
    }, options)
    // The namespace changed while the probe was in flight.
    if (latest !== api) backend.replaceApi(latest)
    return backend
  } catch (error) {
    await releaseAll()
    if (signal?.aborted) throw new ConnectAbortedError()
    if (error instanceof HostConnectError || error instanceof ConnectAbortedError) throw error
    throw new HostConnectError('transient', error instanceof Error ? error.message : String(error), { cause: error })
  }
}

interface PendingCommand {
  readonly input: CommandInput
  readonly track: boolean
  attempts: number
  inFlight: boolean
}

interface PendingPolicy {
  readonly expectedRevision: number
  readonly autoSettleAfterDays: number | null
  readonly keepUnacknowledgedFailures: boolean
}

const samePolicy = (left: TimePolicy, right: TimePolicy): boolean =>
  left.revision === right.revision
  && left.autoSettleAfterDays === right.autoSettleAfterDays
  && left.keepUnacknowledgedFailures === right.keepUnacknowledgedFailures

export class HostBackend implements TaskBackend {
  readonly state: Store<BackendState>
  private api: T3Remote | null
  private epoch: string
  private streamSeq: number
  /** Current subscription generation; bumped on every invalidation. */
  private generation = 1
  /** Generation whose baseline the state reflects (ready iff equal to `generation`). */
  private baselineGeneration = 1
  private stream: AbortController | null = null
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private attempts = 0
  private disposed = false
  private readonly stopReset: () => void
  private readonly retryDelay: (attempt: number) => number
  private readonly onRecovery: (notice: RecoveryNotice) => void
  /** Commands whose replies were lost, keyed by commandId; resent with the same id after a baseline. */
  private readonly unconfirmed = new Map<string, PendingCommand>()
  private unconfirmedPolicy: PendingPolicy | null = null

  constructor(
    api: T3Remote,
    baseline: Snapshot,
    private readonly unmount: () => Promise<void> | void,
    options: HostBackendOptions,
  ) {
    this.api = api
    this.epoch = baseline.epoch
    this.streamSeq = baseline.streamSeq
    this.retryDelay = options.retryDelay ?? defaultRetryDelay
    this.onRecovery = options.onRecovery ?? (() => {})
    this.state = createStore<BackendState>(this.fromSnapshot(baseline))
    this.stopReset = options.onConnectionReset(() => { this.invalidate(true) })
    this.consume(this.generation)
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
      failure: null,
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private isReady(): boolean {
    return !this.disposed && this.baselineGeneration === this.generation && this.state.getSnapshot().status === 'ready'
  }

  /**
   * End the current subscription: its stream and in-flight replies become
   * stale, the state stays visible but marked stale (writes are refused), and a
   * new subscription starts — immediately for a reset or a detected gap,
   * after a backoff when the stream itself failed.
   */
  private invalidate(immediate: boolean): void {
    if (this.disposed) return
    this.generation += 1
    this.stream?.abort()
    this.stream = null
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const current = this.state.getSnapshot()
    if (current.status !== 'stale') this.state.set({ ...current, status: 'stale' })
    if (this.api === null) return // resumes when the namespace comes back
    const attempt = this.attempts++
    const delay = immediate && attempt === 0 ? 0 : this.retryDelay(attempt)
    const generation = this.generation
    if (delay <= 0) { this.consume(generation); return }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.isCurrent(generation)) this.consume(generation)
    }, delay)
  }

  /** The namespace service was replaced (non-null) or removed (null). */
  replaceApi(api: T3Remote | null): void {
    if (this.disposed || api === this.api) return
    this.api = api
    this.attempts = 0
    this.invalidate(true)
  }

  private consume(generation: number): void {
    const api = this.api
    if (api === null || !this.isCurrent(generation)) return
    const abort = new AbortController()
    this.stream = abort
    void (async () => {
      let stream: FollowStream | undefined
      try {
        stream = api.follow(PROTOCOL_VERSION, abort.signal)
        const opened = stream
        abort.signal.addEventListener('abort', () => { opened.dispose?.() }, { once: true })
        for await (const event of stream) {
          if (!this.isCurrent(generation)) return
          this.apply(generation, event)
        }
      } catch {
        // Stream ended by a disconnect or a Host restart; a fresh subscription follows.
      }
      if (this.isCurrent(generation)) this.invalidate(false)
    })()
  }

  private apply(generation: number, event: FollowEvent): void {
    if (event.kind === 'baseline') {
      this.epoch = event.snapshot.epoch
      this.streamSeq = event.snapshot.streamSeq
      this.baselineGeneration = generation
      this.attempts = 0
      this.state.set(this.fromSnapshot(event.snapshot))
      this.recover(event.snapshot)
      return
    }
    // A delta before this stream's baseline, from another epoch, or after a
    // gap cannot be applied: resubscribe for a fresh baseline right away.
    if (this.baselineGeneration !== generation || event.epoch !== this.epoch) { this.invalidate(true); return }
    if (event.streamSeq <= this.streamSeq) return // duplicate
    if (event.streamSeq !== this.streamSeq + 1) { this.invalidate(true); return }
    this.streamSeq = event.streamSeq
    const current = this.state.getSnapshot()
    let tasks: Map<string, TaskView> | null = null
    for (const task of event.tasks) {
      // A command reply can overtake the delta of an earlier revision.
      const existing = (tasks ?? current.tasks).get(task.sessionId)
      if (existing !== undefined && existing.record.revision > task.record.revision) continue
      tasks ??= new Map(current.tasks)
      tasks.set(task.sessionId, task)
    }
    const policy = event.policy === null ? current.policy : this.nextPolicy(current.policy, event.policy)
    if (policy === null) return // invalidated
    this.state.set({
      ...current,
      tasks: tasks ?? current.tasks,
      policy,
      clockOffset: event.serverNow - Date.now(),
    })
  }

  /**
   * Monotonic policy adoption: a newer revision replaces, an older one is a
   * late reply and is ignored, and the same revision with other values means
   * the local copy cannot be trusted — resubscribe (returns null).
   */
  private nextPolicy(current: TimePolicy, incoming: TimePolicy): TimePolicy | null {
    if (incoming.revision > current.revision) return incoming
    if (incoming.revision < current.revision || samePolicy(incoming, current)) return current
    this.invalidate(true)
    return null
  }

  private merge(task: TaskView): void {
    const current = this.state.getSnapshot()
    const existing = current.tasks.get(task.sessionId)
    if (existing !== undefined && existing.record.revision > task.record.revision) return
    const tasks = new Map(current.tasks)
    tasks.set(task.sessionId, task)
    this.state.set({ ...current, tasks })
  }

  async command(sessionId: string, action: CommandAction, context: CommandContext): Promise<CommandOutcome> {
    if (!this.isReady()) {
      return { ok: false, code: 'BASELINE_PENDING', message: 'reconnecting: waiting for a fresh baseline', task: null }
    }
    const input: CommandInput = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: newCommandId(),
      sessionId,
      expectedRevision: this.state.getSnapshot().tasks.get(sessionId)?.record.revision ?? 0,
      action,
      observedPending: context.observedPending === null ? null : [...context.observedPending],
    }
    return await this.send({ input, track: context.background !== true, attempts: 0, inFlight: false })
  }

  /** Send a command (first attempt or a retry with the same commandId and expected revision). */
  private async send(pending: PendingCommand): Promise<CommandOutcome> {
    const generation = this.generation
    const api = this.api
    pending.attempts += 1
    pending.inFlight = true
    let result: RemoteResult<CommandResult>
    try {
      if (api === null) throw new Error('t3Sidebar namespace unavailable')
      result = await api.command(pending.input)
    } catch (error) {
      result = { ok: false, error: error as RemoteFailureLike }
    } finally {
      pending.inFlight = false
    }
    if (!result.ok || result.value === undefined) {
      const refused = refusalCode(result.error)
      if (refused !== null) {
        // Rejected before dispatch: certainly not applied.
        this.unconfirmed.delete(pending.input.commandId)
        return { ok: false, code: refused, message: describeFailure(result.error), task: null }
      }
      // Lost reply: the command may have been committed. Keep it for recovery
      // and resubscribe so a fresh baseline tells us.
      const message = `result unknown: ${describeFailure(result.error)}`
      if (this.disposed) return { ok: false, code: 'UNCONFIRMED', message, task: null }
      if (pending.track) this.unconfirmed.set(pending.input.commandId, pending)
      if (generation === this.generation) this.invalidate(true)
      return { ok: false, code: 'UNCONFIRMED', message, task: null }
    }
    this.unconfirmed.delete(pending.input.commandId)
    if (result.value.task !== null && this.isCurrent(generation)) this.merge(result.value.task)
    return result.value
  }

  async setPolicy(days: number | null, keepFailures: boolean): Promise<PolicyOutcome> {
    const current = this.state.getSnapshot()
    if (!this.isReady()) {
      return { ok: false, code: 'BASELINE_PENDING', message: 'reconnecting: waiting for a fresh baseline', policy: current.policy }
    }
    const generation = this.generation
    const request: PendingPolicy = { expectedRevision: current.policy.revision, autoSettleAfterDays: days, keepUnacknowledgedFailures: keepFailures }
    let result: RemoteResult<PolicyResult>
    try {
      if (this.api === null) throw new Error('t3Sidebar namespace unavailable')
      result = await this.api.setPolicy({ protocolVersion: PROTOCOL_VERSION, ...request })
    } catch (error) {
      result = { ok: false, error: error as RemoteFailureLike }
    }
    const latest = this.state.getSnapshot().policy
    if (!result.ok || result.value === undefined) {
      const refused = refusalCode(result.error)
      if (refused !== null) {
        return { ok: false, code: refused, message: describeFailure(result.error), policy: latest }
      }
      // Policy writes carry no receipt: recovery compares the next baseline's
      // policy with this request (see `recover`); there is no automatic resend.
      const message = `result unknown: ${describeFailure(result.error)}`
      if (this.disposed) return { ok: false, code: 'UNCONFIRMED', message, policy: latest }
      this.unconfirmedPolicy = request
      if (generation === this.generation) this.invalidate(true)
      return { ok: false, code: 'UNCONFIRMED', message, policy: latest }
    }
    if (this.isCurrent(generation)) {
      const state = this.state.getSnapshot()
      const policy = this.nextPolicy(state.policy, result.value.policy)
      if (policy !== null && policy !== state.policy) this.state.set({ ...state, policy })
    }
    return result.value
  }

  /** After a baseline: settle operations whose replies were lost. */
  private recover(snapshot: Snapshot): void {
    const pendingPolicy = this.unconfirmedPolicy
    if (pendingPolicy !== null) {
      this.unconfirmedPolicy = null
      const policy = snapshot.policy
      const outcome = policy.revision === pendingPolicy.expectedRevision
        ? 'not-applied'
        // Values equal to the request: ours (or an identical concurrent write; same result).
        : policy.autoSettleAfterDays === pendingPolicy.autoSettleAfterDays && policy.keepUnacknowledgedFailures === pendingPolicy.keepUnacknowledgedFailures
          ? 'committed'
          : 'superseded'
      this.onRecovery({ kind: 'policy', outcome })
    }
    for (const [commandId, pending] of this.unconfirmed) {
      if (pending.inFlight) continue
      const sessionId = pending.input.sessionId
      if (pending.attempts > MAX_RECOVERY_ATTEMPTS) {
        this.unconfirmed.delete(commandId)
        this.onRecovery({ kind: 'command', outcome: 'gave-up', sessionId })
        continue
      }
      // Same commandId and expected revision: the Host replays a committed
      // command from its receipt, applies an uncommitted one only if nothing
      // changed since, and otherwise answers CONFLICT.
      void this.send(pending).then((outcome) => {
        if (this.disposed || (!outcome.ok && outcome.code === 'UNCONFIRMED')) return
        this.onRecovery(outcome.ok
          ? { kind: 'command', outcome: 'committed', sessionId }
          : { kind: 'command', outcome: 'not-applied', sessionId, code: outcome.code })
      })
    }
  }

  async listTransitions(limit: number) {
    if (this.api === null) return []
    try {
      const result = await this.api.listTransitions(limit)
      return result.ok && result.value !== undefined ? result.value : []
    } catch {
      return []
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.stream?.abort()
    this.stream = null
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.unconfirmed.clear()
    this.unconfirmedPolicy = null
    this.stopReset()
    void Promise.resolve().then(this.unmount).catch((error: unknown) => {
      console.warn('[dsh-t3code-sidebar] Remote unmount failed:', error)
    })
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

  private disposed = false

  constructor(
    reason: string,
    private readonly factsFor: (sessionId: string) => { facts: TaskFacts; native: NativeState } | null,
    private readonly store = new LocalRecordStore(),
    failure: HostFailure | null = null,
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
      failure,
    })
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
    if (this.channel !== null) this.channel.onmessage = () => { this.reload() }
    globalThis.addEventListener?.('storage', this.onStorage)
    this.timer = setInterval(() => { void this.tick() }, 15_000)
  }

  private reload(): void {
    if (this.disposed) return
    this.records = this.store.readAll()
    this.publish()
  }

  /** After a store write: refresh from the store (which keeps unpersisted records), render, tell other tabs. */
  private afterWrite(_sessionId: string, _written: TaskRecord | null): void {
    // A write that finishes after dispose is stored; only this instance stops rendering it.
    if (this.disposed) return
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
      if (this.disposed) return
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

  async command(sessionId: string, action: CommandAction, context: CommandContext): Promise<CommandOutcome> {
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

  async setPolicy(): Promise<PolicyOutcome> {
    return { ok: false, code: 'UNSUPPORTED_HOST', message: 'automatic settling needs the Host service', policy: this.state.getSnapshot().policy }
  }

  async listTransitions() { return [] }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.channel?.close()
    globalThis.removeEventListener?.('storage', this.onStorage)
  }
}
