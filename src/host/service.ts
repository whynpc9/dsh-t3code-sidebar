/**
 * Host half: the `t3Sidebar` task-state service.
 *
 * - Persists plugin-owned task records in the `t3_sidebar` storage domain.
 * - Folds committed `session/event`s into per-session activity summaries.
 * - Applies revision-checked, idempotent commands through one serial queue.
 * - Runs the policy scheduler (Snooze expiry + automatic settle).
 * - Publishes a baseline + ordered deltas to owner Clients.
 *
 * Remote methods are dispatched by the Gateway's SRC marker path; every
 * argument is validated with the protocol zod schemas before use.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  CommandInputSchema, PolicyInputSchema, PreviewInputSchema, PROTOCOL_VERSION, TaskRecordSchema, TimePolicySchema, TransitionSchema,
  type Capabilities, type CommandInput, type CommandResult, type FollowEvent, type HeldResult, type PolicyPreview, type PolicyResult,
  type Snapshot, type TaskView, type TransitionEntry,
} from '../contracts/schema.ts'
import { NAMESPACE, PROTOCOL_MISMATCH_CODE, SERVICE_KEY } from '../contracts/remote.ts'
import { decideAutoSettle } from '../domain/autosettle.ts'
import {
  acknowledgeResult, autoSettle, foldActivity, reconcile, reopen, setPolicyOverride, settle, snooze,
  type FoldableEvent, type TaskErrorCode, type Transition,
} from '../domain/commands.ts'
import { effectivePolicy, graceSince, isStricter, stricterWorkspaces } from '../domain/policy.ts'
import {
  DAY_MS, DEFAULT_AUTO_SETTLE_DAYS, EMPTY_ACTIVITY, MAX_AUTO_SETTLE_DAYS, emptyRecord, known, unknown,
  type ActivitySummary, type Known, type NativeState, type PendingSignal, type TaskFacts, type TaskRecord, type TimePolicy,
} from '../domain/types.ts'
import {
  optionalService,
  type HostLiveSessions, type HostSession, type HostSessionActivity, type HostSessionEvent, type HostSessionHeader,
  type HostSessionReadHandle,
  type HostProjectionsValue, type HostSessionController, type HostSessionPersistence, type HostWorkspaceRegistry, type OpenDomain,
} from './harness.ts'

const GlobalSchema = z.object({
  installationId: z.string(),
  installedAt: z.number(),
  dataRevision: z.number(),
  policy: TimePolicySchema,
  /** Grace start applied to every session when the policy was (re)enabled or shortened. */
  policyEligibleSince: z.number(),
  /**
   * Last persistence change token seen (or verified) per session. A token that
   * changed while this plugin observed no event *may* mean activity happened
   * while it was not running (disabled, uninstalled, quit before the next
   * refresh); it is only a hint that triggers verification, never proof.
   */
  seenRevisions: z.record(z.string(), z.string()).default({}),
  /** Native archive set at the last sweep; a session leaving it was restored. */
  archivedSeen: z.array(z.string()).default([]),
  /**
   * Grace start per workspace whose effective window became stricter (an
   * override enabled or shortened, or removed in favor of a stricter Host
   * default). Applies to that workspace's members only.
   */
  workspaceEligibleSince: z.record(z.string(), z.number()).default({}),
  /** Workspace membership per session at the last sweep ('' = none); a change of rule restarts grace. */
  membership: z.record(z.string(), z.string()).default({}),
  /** Per-session grace start after its membership moved it under another rule. */
  sessionEligibleSince: z.record(z.string(), z.number()).default({}),
})
type GlobalState = z.infer<typeof GlobalSchema>

const NOT_INSTALLED: GlobalState = {
  installationId: '',
  installedAt: 0,
  dataRevision: 0,
  policy: {
    revision: 0, autoSettleAfterDays: DEFAULT_AUTO_SETTLE_DAYS, keepUnacknowledgedFailures: false,
    keepUnacknowledgedResults: false, workspaceOverrides: {},
  },
  policyEligibleSince: 0,
  seenRevisions: {},
  archivedSeen: [],
  workspaceEligibleSince: {},
  membership: {},
  sessionEligibleSince: {},
}

export const TASK_DOMAIN = defineDomain({
  name: 't3_sidebar',
  version: 1,
  global: { schema: GlobalSchema, initial: NOT_INSTALLED },
  tables: {
    tasks: domainTable(TaskRecordSchema),
    transitions: domainTable(TransitionSchema),
  },
})

const SWEEP_MS = 60_000
const HEADER_REFRESH_MS = 10 * 60_000
const MAX_TIMER_MS = 2 ** 31 - 1
const RECEIPTS_PER_RECORD = 16
const TRANSITIONS_MAX = 1000
const FOLLOW_BUFFER = 1000
const ACTIVITY_CONCURRENCY = 2
const PENDING_READ_TIMEOUT_MS = 5_000
const REPLAY_TIMEOUT_MS = 10_000
const REPLAY_CHUNK = 512
/** Workspace membership is re-read at most this often for views (sweeps always read it fresh). */
const MEMBERSHIP_MAX_AGE_MS = 1000
/** A grace start older than the longest window cannot postpone any deadline. */
const GRACE_RETENTION_MS = MAX_AUTO_SETTLE_DAYS * DAY_MS
const PREVIEW_HELD_MAX = 200

type Domain = OpenDomain<TaskRecord, TransitionEntry, GlobalState>

interface Follower {
  readonly push: (event: FollowEvent) => void
  readonly close: (error?: Error) => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    t3Sidebar: T3SidebarService
  }
}

const randomId = (): string => globalThis.crypto.randomUUID()

/** Serializes async jobs; a failed job does not poison the queue. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job)
    this.tail = result.catch(() => undefined)
    return result
  }
}

export class T3SidebarService extends TypertRemoteService {
  static inject = ['storageDomain']

  private domain: Domain | undefined
  private readonly queue = new SerialQueue()
  private readonly epoch = randomId()
  private streamSeq = 0
  private readonly followers = new Set<Follower>()
  private readonly headers = new Map<string, HostSessionHeader>()
  /** Last durable pending-request answer per session (timed questions outlive turns). */
  private readonly pendingCache = new Map<string, Known<readonly PendingSignal[]>>()
  /** Sessions with committed events observed live since the last header refresh began. */
  private observedLive = new Set<string>()
  /** Snooze expiries whose write failed: retry not before `at` (backoff). */
  private readonly expiryRetry = new Map<string, { readonly failures: number; readonly at: number }>()
  /** Sessions whose event fold could not be persisted; catch-up recovers them. */
  private readonly failedFolds = new Set<string>()
  /** When this service started: sessions created since then had every event observed live. */
  private readonly startedAt = Date.now()
  /** Sessions whose stored log was replayed into the summary by this process (latest result known). */
  private readonly historyFolded = new Set<string>()
  /**
   * Sessions whose summary is known to miss an event (a live fold could not be
   * persisted). Only a successful replay clears this; catch-up resetting the
   * grace window does not recover the event.
   */
  private readonly historyInvalid = new Set<string>()
  /** Invalidation count per session: a replay only vouches for history if none happened while it read. */
  private readonly historyInvalidations = new Map<string, number>()
  /** History rebuilds waiting or running, and failed ones with their retry instant. */
  private readonly historyQueue = new Set<string>()
  private readonly historyRetry = new Map<string, { readonly failures: number; readonly at: number }>()
  private historyRebuild: Promise<void> | undefined
  /**
   * Parked sessions whose change token moved without observed events: the
   * token to acknowledge once a replay verified them, and the retry backoff.
   */
  private readonly unverified = new Map<string, { readonly token: string; readonly failures: number; readonly at: number }>()
  private readonly verifying = new Set<string>()
  /** The verification pass in flight; replay work never runs on the scheduling path. */
  private verification: Promise<void> | undefined
  /** Last activity answer per session and when it was taken. */
  private readonly activityCache = new Map<string, { readonly value: Known<readonly string[]>; readonly at: number; readonly failures: number }>()
  /** Session → workspace id, read from the workspace registry (null: registry without a listing). */
  private membershipCache: { readonly at: number; readonly map: ReadonlyMap<string, string> | null } | undefined
  /** The last membership change could not be persisted (its grace is not durable yet). */
  private membershipUnsaved = false
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Fixed instant of the next fallback sweep; commits never push it later. */
  private fallbackSweepAt = Date.now() + SWEEP_MS
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false
  private capabilities: Capabilities = { hostActivity: false, sessionEvents: false, hostPending: false }
  private markReady: () => void = () => {}
  /**
   * Settles once storage is open and the startup catch-up has run, including
   * the first verification pass over parked sessions. Snooze expiry and the
   * scheduler start before that pass and never wait for it.
   */
  readonly ready: Promise<void> = new Promise((resolve) => { this.markReady = resolve })

  constructor(ctx: Context) {
    super(ctx, SERVICE_KEY, { namespace: NAMESPACE })
  }

  protected async [Service.init](): Promise<void> {
    this.domain = await (this.ctx.storageDomain as { open(spec: unknown): Promise<Domain> }).open(TASK_DOMAIN)
    const global = this.domain.global.get()
    if (global.installationId === '') {
      const now = Date.now()
      await this.domain.global.set({ ...NOT_INSTALLED, installationId: randomId(), installedAt: now, policyEligibleSince: now })
    }
    this.capabilities = {
      hostActivity: true,
      sessionEvents: true,
      hostPending: false,
    }
    this.ctx.on('session/event', (session: HostSession, event: HostSessionEvent) => {
      this.onSessionEvent(session, event)
    })
    this.ctx.effect(() => () => this.dispose(), 't3Sidebar: scheduler and followers')
    await this.refreshHeaders()
    const refresh = setInterval(() => { void this.refreshHeaders() }, HEADER_REFRESH_MS)
    this.ctx.effect(() => () => clearInterval(refresh), 't3Sidebar: header refresh')
    // Catch up Snooze expiries and due auto-settles missed while the Host was down.
    void this.sweep()
    void this.verifyDue().finally(() => this.markReady())
    // Learn which sessions already have background work (jobs, subagents,
    // schedules) so they show as Working and enter the refresh set.
    void this.seedActivity()
  }

  /** Sample activity for every known session once, with bounded concurrency. */
  private async seedActivity(): Promise<void> {
    const ids = [...this.headers.keys()]
    for (let index = 0; index < ids.length && !this.disposed; index += ACTIVITY_CONCURRENCY) {
      await Promise.all(ids.slice(index, index + ACTIVITY_CONCURRENCY).map(async (sessionId) => {
        if (this.activityCache.has(sessionId)) return
        const activity = await this.queryActivity(sessionId)
        if (!activity.known || activity.value.length > 0) this.publish([this.viewOf(this.recordOf(sessionId, Date.now()))], null)
      }))
    }
  }

  // ── Remote surface ────────────────────────────────────────────────────────

  @Remote('getSnapshot')
  getSnapshot(t3ProtocolVersion: number): Snapshot {
    this.assertProtocol(t3ProtocolVersion)
    return this.snapshot()
  }

  @Remote({ name: 'follow', mode: 'stream' })
  follow(t3ProtocolVersion: number, signal: AbortSignal): AsyncIterable<FollowEvent> {
    this.assertProtocol(t3ProtocolVersion)
    return this.openFollow(signal)
  }

  @Remote('command')
  async command(t3CommandInput: unknown): Promise<CommandResult> {
    const parsed = CommandInputSchema.safeParse(t3CommandInput)
    if (!parsed.success) return { ok: false, code: 'PROTOCOL_MISMATCH', message: parsed.error.message, task: null }
    if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
      return { ok: false, code: 'PROTOCOL_MISMATCH', message: `protocol ${parsed.data.protocolVersion} unsupported`, task: null }
    }
    return await this.queue.run(() => this.applyCommand(parsed.data))
  }

  @Remote('setPolicy')
  async setPolicy(t3PolicyInput: unknown): Promise<PolicyResult> {
    const parsed = PolicyInputSchema.safeParse(t3PolicyInput)
    const domain = this.requireDomain()
    if (!parsed.success) {
      return { ok: false, code: 'PROTOCOL_MISMATCH', message: parsed.error.message, policy: domain.global.get().policy }
    }
    return await this.queue.run(async () => {
      const global = domain.global.get()
      if (parsed.data.expectedRevision !== global.policy.revision) {
        return { ok: false, code: 'CONFLICT', message: 'policy changed', policy: global.policy }
      }
      const before = global.policy
      const policy: TimePolicy = {
        revision: before.revision + 1,
        autoSettleAfterDays: parsed.data.autoSettleAfterDays,
        keepUnacknowledgedFailures: parsed.data.keepUnacknowledgedFailures,
        keepUnacknowledgedResults: parsed.data.keepUnacknowledgedResults ?? before.keepUnacknowledgedResults,
        workspaceOverrides: parsed.data.workspaceOverrides ?? before.workspaceOverrides,
      }
      const next: GlobalState = { ...withPolicyGrace(global, policy, Date.now()), dataRevision: global.dataRevision + 1 }
      await domain.global.set(next)
      this.publish([], policy)
      this.schedule()
      return { ok: true, policy }
    })
  }

  /**
   * Evaluate a policy without writing. With a draft, the grace windows that
   * saving it would start are applied too, so the preview shows what the
   * saved policy would do. Display facts only (like the published views): the
   * sweep re-reads activity and pending state before acting.
   */
  @Remote('previewPolicy')
  previewPolicy(t3PreviewInput: unknown): PolicyPreview {
    const input = PreviewInputSchema.parse(t3PreviewInput)
    this.assertProtocol(input.protocolVersion)
    const stored = this.requireDomain().global.get()
    const now = Date.now()
    const policy: TimePolicy = input.draft === null ? stored.policy : { ...input.draft, revision: stored.policy.revision }
    const global = input.draft === null ? stored : withPolicyGrace(stored, policy, now)
    const skips: Record<string, number> = {}
    const held: HeldResult[] = []
    let heldTotal = 0
    let due = 0
    let sessions = 0
    let nextDeadline: PolicyPreview['nextDeadline'] = null
    const membership = this.knownMemberships()
    for (const header of this.headers.values()) {
      sessions += 1
      const workspaceId = membership?.get(header.id) ?? null
      const raw = this.recordOf(header.id, now)
      const record = this.withGrace(raw, global, workspaceId)
      const decision = decideAutoSettle({
        policy, workspaceId, scopeKnown: membership !== null, record,
        facts: {
          ...this.factsOf(record, this.cachedActivity(record), null, this.pendingCache.get(record.sessionId) ?? known([])),
          resultHistoryKnown: this.resultHistoryKnown(header.id),
        },
        native: this.nativeOf(record.sessionId),
        createdAt: header.createdAt,
        now,
      })
      if (decision.eligible) { due += 1; continue }
      const skip = decision.skip ?? 'unknown'
      skips[skip] = (skips[skip] ?? 0) + 1
      if (skip === 'not-due' && decision.deadline !== null && (nextDeadline === null || decision.deadline < nextDeadline.at)) {
        nextDeadline = { sessionId: header.id, at: decision.deadline }
      }
      if ((skip === 'unacknowledged-failure' || skip === 'unacknowledged-result') && raw.activity.lastTurnEnd !== null) {
        heldTotal += 1
        if (held.length < PREVIEW_HELD_MAX) held.push({ sessionId: header.id, turnEndSeq: raw.activity.lastTurnEnd.seq, reason: skip })
      }
    }
    return { policyRevision: stored.policy.revision, evaluatedAt: now, sessions, due, nextDeadline, skips, held, heldTotal }
  }

  @Remote('listTransitions')
  listTransitions(t3Limit: number): TransitionEntry[] {
    const n = z.number().int().min(1).max(TRANSITIONS_MAX).parse(t3Limit)
    return [...this.requireDomain().table('transitions').entries()]
      .map(([, entry]) => entry)
      .sort((left, right) => right.at - left.at)
      .slice(0, n)
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private async applyCommand(input: CommandInput): Promise<CommandResult> {
    const domain = this.requireDomain()
    const now = Date.now()
    if (!this.sessionKnown(input.sessionId)) {
      return { ok: false, code: 'NOT_FOUND', message: 'unknown session', task: null }
    }
    const current = this.recordOf(input.sessionId, now)
    const digest = JSON.stringify(input.action)
    const receipt = current.receipts.find(entry => entry.commandId === input.commandId)
    if (receipt !== undefined) {
      if (receipt.digest !== digest) {
        return { ok: false, code: 'CONFLICT', message: 'command id reused with another payload', task: this.viewOf(current) }
      }
      // Re-publish on replay: a client retrying after a lost response, or other
      // windows that missed the original delta, converge on the committed state.
      const view = this.viewOf(current)
      this.publish([view], null)
      return { ok: true, task: view, dataRevision: domain.global.get().dataRevision, replayed: true }
    }
    if (input.expectedRevision !== current.revision) {
      return { ok: false, code: 'CONFLICT', message: 'task changed', task: this.viewOf(current) }
    }
    const native = this.nativeOf(input.sessionId)
    const activity = await this.queryActivity(input.sessionId)
    const facts = this.factsOf(current, activity, input.observedPending, await this.queryDurablePending(input.sessionId))
    let transition: Transition
    switch (input.action.kind) {
      case 'snooze': transition = snooze(current, facts, native, input.action.until, now); break
      case 'settle': transition = settle(current, facts, native, now); break
      case 'reopen': transition = reopen(current, now); break
      case 'policy-override': transition = setPolicyOverride(current, input.action.override, now); break
      case 'acknowledge-result': transition = acknowledgeResult(current, input.action.turnEndSeq); break
    }
    if (!transition.ok) {
      return { ok: false, code: transition.code satisfies TaskErrorCode, message: transition.message, task: this.viewOf(current) }
    }
    const record: TaskRecord = {
      ...transition.record,
      receipts: [...current.receipts, { commandId: input.commandId, revision: transition.record.revision, digest }]
        .slice(-RECEIPTS_PER_RECORD),
    }
    try {
      await this.commit(record, current, `manual:${input.action.kind}`, null)
    } catch (error) {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: String(error), task: this.viewOf(current) }
    }
    return { ok: true, task: this.viewOf(record), dataRevision: domain.global.get().dataRevision, replayed: false }
  }

  /** Persist first, then publish; audit entries carry no message content. */
  private async commit(
    record: TaskRecord, before: TaskRecord, reason: string,
    audit: { anchorAt: number; deadline: number; policyRevision: number } | null,
  ): Promise<void> {
    const domain = this.requireDomain()
    // The task record (with its command receipt) is the single authoritative
    // write: if it fails, nothing changed. Once it succeeds the change is
    // committed and is always published; the revision counter and audit entry
    // that follow are best-effort bookkeeping and cannot undo it.
    await domain.table('tasks').put(record.sessionId, record)
    try {
      const global = domain.global.get()
      await domain.global.set({ ...global, dataRevision: global.dataRevision + 1 })
    } catch {
      // dataRevision is informational; the record revision guards commands.
    }
    if (before.disposition.kind !== record.disposition.kind) {
      await this.appendTransition({
        id: randomId(),
        at: Date.now(),
        sessionId: record.sessionId,
        from: before.disposition.kind,
        to: record.disposition.kind,
        reason,
        policyRevision: audit?.policyRevision ?? null,
        anchorAt: audit?.anchorAt ?? null,
        deadline: audit?.deadline ?? null,
      }).catch(() => undefined)
    }
    this.publish([this.viewOf(record)], null)
    this.schedule()
  }

  private async appendTransition(entry: TransitionEntry): Promise<void> {
    const table = this.requireDomain().table('transitions')
    await table.put(entry.id, entry)
    const all = [...table.entries()]
    if (all.length > TRANSITIONS_MAX) {
      const oldest = all.sort((left, right) => left[1].at - right[1].at).slice(0, all.length - TRANSITIONS_MAX)
      for (const [id] of oldest) await table.delete(id)
    }
  }

  // ── Facts ─────────────────────────────────────────────────────────────────

  private recordOf(sessionId: string, now: number): TaskRecord {
    const stored = this.domain?.table('tasks').get(sessionId)
    if (stored !== undefined) return stored
    const since = this.requireDomain().global.get().policyEligibleSince
    return emptyRecord(sessionId, since > 0 ? since : now)
  }

  private sessionKnown(sessionId: string): boolean {
    if (this.headers.has(sessionId)) return true
    const live = optionalService<HostLiveSessions>(this.ctx, 'sessions')
    return live?.list().some(entry => entry.header.id === sessionId) ?? false
  }

  private nativeOf(sessionId: string): NativeState {
    const registry = optionalService<HostWorkspaceRegistry>(this.ctx, 'workspaceRegistry')
    return {
      pinned: registry?.pinnedSessionIds.includes(sessionId) ?? false,
      archived: registry?.archivedSessionIds.includes(sessionId) ?? false,
    }
  }

  /** Ask every composed provider what still runs for the session (turn, subagent, job, schedule). */
  private async queryActivity(sessionId: string): Promise<Known<readonly string[]>> {
    try {
      const waterfall = (this.ctx as unknown as {
        waterfall(name: string, request: unknown, next: () => Promise<readonly HostSessionActivity[]>): Promise<readonly HostSessionActivity[]>
      }).waterfall
      const at = Date.now()
      const activity = await waterfall.call(this.ctx, 'workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      const value = known(activity.map(entry => entry.kind))
      this.activityCache.set(sessionId, { value, at, failures: 0 })
      return value
    } catch {
      const failures = (this.activityCache.get(sessionId)?.failures ?? 0) + 1
      this.activityCache.set(sessionId, { value: unknown, at: Date.now(), failures })
      return unknown
    }
  }

  /**
   * Durable pending requests from the exact projection read: timed user
   * questions (`userQuestions.active`, `open` or `continued`) can outlive the
   * turn, so an empty activity list alone does not prove nothing is pending.
   * Anything that cannot be established exactly stays unknown.
   */
  private async queryDurablePending(sessionId: string): Promise<Known<readonly PendingSignal[]>> {
    let answer: Known<readonly PendingSignal[]> = unknown
    try {
      const controller = optionalService<HostSessionController>(this.ctx, 'sessionController')
      if (controller !== undefined) {
        const read = await controller.projections({ sessionId }, AbortSignal.timeout(PENDING_READ_TIMEOUT_MS))
        answer = durablePendingOf(read)
      }
    } catch {
      answer = unknown
    }
    this.pendingCache.set(sessionId, answer)
    return answer
  }

  /**
   * Cached activity, corrected by the journal: `turn/end` is emitted while the
   * Agent is still unwinding its turn, so a `turn` entry sampled before the
   * latest turn end is stale.
   */
  private cachedActivity(record: TaskRecord): Known<readonly string[]> {
    const cached = this.activityCache.get(record.sessionId)
    if (cached === undefined || !cached.value.known) return cached?.value ?? unknown
    const end = record.activity.lastTurnEnd
    const start = record.activity.lastTurnStartSeq
    const turnClosed = end !== null && (start === null || end.seq > start)
    if (turnClosed && end.at >= cached.at - 50) return known(cached.value.value.filter(kind => kind !== 'turn'))
    return cached.value
  }

  /**
   * Compare the native archive set with the one seen at the last sweep. A
   * session that left it was restored (from any window, or while this Host
   * was down): its idle window restarts now, so a restored long-idle session
   * is not settled seconds after Restore (time-policy spec §4).
   */
  private async graceRestoredSessions(): Promise<void> {
    const registry = optionalService<HostWorkspaceRegistry>(this.ctx, 'workspaceRegistry')
    if (registry === undefined) return
    const domain = this.requireDomain()
    const current = [...registry.archivedSessionIds]
    const archived = new Set(current)
    const now = Date.now()
    for (const sessionId of domain.global.get().archivedSeen) {
      if (archived.has(sessionId) || !this.headers.has(sessionId)) continue
      const before = this.recordOf(sessionId, now)
      const record: TaskRecord = { ...before, policyEligibleSince: now, revision: before.revision + 1 }
      try {
        await this.commit(record, before, 'restored', null)
      } catch {
        // Keep it in the seen set so the next sweep retries the grace reset.
        current.push(sessionId)
      }
    }
    const seen = domain.global.get().archivedSeen
    if (seen.length !== current.length || seen.some((id, index) => id !== current[index])) {
      await domain.global.set({ ...domain.global.get(), archivedSeen: current }).catch(() => undefined)
    }
  }

  /** Re-query every session whose cached activity is non-empty; publish changed views. */
  private async refreshOutstandingActivity(): Promise<void> {
    const now = Date.now()
    const outstanding = [...this.activityCache]
      .filter(([, cached]) => cached.value.known
        ? cached.value.value.length > 0
        // Failed answers are retried with backoff instead of being dropped.
        : now >= cached.at + unknownRetryDelay(cached.failures))
      .map(([sessionId]) => sessionId)
    for (let index = 0; index < outstanding.length; index += ACTIVITY_CONCURRENCY) {
      await Promise.all(outstanding.slice(index, index + ACTIVITY_CONCURRENCY).map(async (sessionId) => {
        if (this.domain === undefined) return
        const record = this.recordOf(sessionId, Date.now())
        const before = JSON.stringify(this.cachedActivity(record))
        await this.queryActivity(sessionId)
        if (JSON.stringify(this.cachedActivity(record)) !== before) this.publish([this.viewOf(record)], null)
      }))
    }
  }

  /** Re-sample activity once the Agent has finished unwinding a turn. */
  private refreshActivitySoon(sessionId: string): void {
    for (const delay of [400, 2500]) {
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer)
        if (this.disposed || this.domain === undefined) return
        const before = JSON.stringify(this.cachedActivity(this.recordOf(sessionId, Date.now())))
        void this.queryActivity(sessionId).then(() => {
          const record = this.domain?.table('tasks').get(sessionId)
          if (record === undefined) return
          if (JSON.stringify(this.cachedActivity(record)) !== before) this.publish([this.viewOf(record)], null)
        })
      }, delay)
      this.pendingTimers.add(timer)
    }
  }

  /**
   * Host facts. Interactive waits (approvals, blocking questions) happen inside
   * a turn, so a known-empty activity list also proves "nothing pending" for
   * the Host's purposes; Client-observed pending signals are added as a lower bound.
   */
  private factsOf(
    record: TaskRecord, activity: Known<readonly string[]>, observedPending: readonly PendingSignal[] | null,
    durablePending: Known<readonly PendingSignal[]> = this.pendingCache.get(record.sessionId) ?? unknown,
  ): TaskFacts {
    const running: Known<boolean> = activity.known ? known(activity.value.includes('turn')) : unknown
    let pending: Known<readonly PendingSignal[]> = unknown
    if (observedPending !== null) {
      // Browser observations are a lower bound, never proof of absence: a cold
      // summary can omit the questions projection. They are complete only
      // together with an exact durable read; on their own, a non-empty list
      // still proves something is pending, but an empty one proves nothing.
      if (durablePending.known) pending = known(mergePending(observedPending, durablePending.value))
      else if (observedPending.length > 0) pending = known(observedPending)
    } else if (activity.known && !activity.value.includes('turn') && durablePending.known) {
      // In-turn waits (approvals, blocking questions) show up as `turn`
      // activity; outside a turn only durable asks can still be pending.
      pending = durablePending
    }
    return { running, activity, pending, summary: record.activity }
  }

  private viewOf(record: TaskRecord): TaskView {
    const global = this.requireDomain().global.get()
    const activity = this.cachedActivity(record)
    const header = this.headers.get(record.sessionId)
    let autoSettleDeadline: number | null = null
    let autoSettleSkip: string | null = null
    if (header !== undefined) {
      const membership = this.knownMemberships()
      const workspaceId = membership?.get(record.sessionId) ?? null
      const decision = decideAutoSettle({
        policy: global.policy,
        workspaceId,
        scopeKnown: membership !== null,
        record: this.withGrace(record, global, workspaceId),
        // Display only: a session whose durable state was not read yet shows its
        // time-based status; the sweep reads exact pending state before acting.
        facts: {
          ...this.factsOf(record, activity, null, this.pendingCache.get(record.sessionId) ?? known([])),
          resultHistoryKnown: this.resultHistoryKnown(record.sessionId),
        },
        native: this.nativeOf(record.sessionId),
        createdAt: header.createdAt,
        now: Date.now(),
      })
      autoSettleDeadline = decision.deadline
      autoSettleSkip = decision.skip
    }
    return {
      sessionId: record.sessionId,
      record,
      activity: activity.known ? [...activity.value] : null,
      autoSettleDeadline,
      autoSettleSkip,
    }
  }

  /** The record with its effective grace start (record, Host, workspace and membership graces). */
  private withGrace(record: TaskRecord, global: GlobalState, workspaceId: string | null): TaskRecord {
    const since = graceSince({
      recordSince: record.policyEligibleSince,
      source: effectivePolicy(global.policy, workspaceId).source,
      hostSince: global.policyEligibleSince,
      workspaceSince: workspaceId === null ? undefined : global.workspaceEligibleSince[workspaceId],
      sessionSince: global.sessionEligibleSince[record.sessionId],
    })
    return since === record.policyEligibleSince ? record : { ...record, policyEligibleSince: since }
  }

  /** Session → workspace id from the registry's synchronous projection; null without one. */
  private memberships(maxAgeMs = MEMBERSHIP_MAX_AGE_MS): ReadonlyMap<string, string> | null {
    const now = Date.now()
    if (this.membershipCache !== undefined && now - this.membershipCache.at < maxAgeMs) return this.membershipCache.map
    let map: Map<string, string> | null = null
    const registry = optionalService<HostWorkspaceRegistry>(this.ctx, 'workspaceRegistry')
    try {
      if (registry?.list !== undefined) {
        map = new Map()
        for (const workspace of registry.list()) {
          for (const sessionId of workspace.sessionIds) if (!map.has(sessionId)) map.set(sessionId, workspace.id)
        }
      }
    } catch {
      map = null
    }
    this.membershipCache = { at: now, map }
    return map
  }

  /**
   * Whether the session's summary is known to hold its latest result: its
   * stored log was replayed by this process, or it was created after this
   * process started (every event was folded live). A fold that could not be
   * persisted makes it unknown again.
   */
  private resultHistoryKnown(sessionId: string): boolean {
    if (this.failedFolds.has(sessionId) || this.historyInvalid.has(sessionId)) return false
    if (this.historyFolded.has(sessionId)) return true
    const header = this.headers.get(sessionId)
    return header !== undefined && header.createdAt >= this.startedAt
  }

  /**
   * Replay stored logs read-only into the summaries of the given sessions, in
   * the background with bounded concurrency; the fold is committed through the
   * serial queue. A failed read backs off and is retried by a later sweep.
   */
  private rebuildHistory(sessionIds: readonly string[]): void {
    const now = Date.now()
    for (const sessionId of sessionIds) {
      const retry = this.historyRetry.get(sessionId)
      if (retry === undefined || now >= retry.at) this.historyQueue.add(sessionId)
    }
    this.historyRebuild ??= (async () => {
      while (this.historyQueue.size > 0 && !this.disposed) {
        const batch = [...this.historyQueue].slice(0, ACTIVITY_CONCURRENCY)
        for (const sessionId of batch) this.historyQueue.delete(sessionId)
        await Promise.all(batch.map(sessionId => this.rebuildOne(sessionId)))
      }
    })().catch(() => undefined).finally(() => { this.historyRebuild = undefined })
  }

  private async rebuildOne(sessionId: string): Promise<void> {
    const invalidations = this.historyInvalidations.get(sessionId) ?? 0
    const events = await this.replayFoldable(sessionId)
    if (this.disposed) return
    const committed = events !== null && await this.queue.run(async () => {
      const before = this.recordOf(sessionId, Date.now())
      let activity = before.activity
      for (const event of events) activity = foldActivity(activity, event)
      if (activity !== before.activity) {
        await this.commit({ ...before, activity, revision: before.revision + 1 }, before, 'history-rebuilt', null)
      }
      return true
    }).catch(() => false)
    if (committed && (this.historyInvalidations.get(sessionId) ?? 0) !== invalidations) {
      // A fold failed while the log was being read: that event may be missing; replay again.
      this.historyQueue.add(sessionId)
    } else if (committed) {
      this.historyFolded.add(sessionId)
      this.historyInvalid.delete(sessionId)
      this.historyRetry.delete(sessionId)
    } else {
      const failures = (this.historyRetry.get(sessionId)?.failures ?? 0) + 1
      this.historyRetry.set(sessionId, { failures, at: Date.now() + unknownRetryDelay(failures) })
    }
  }

  /**
   * Record workspace membership; a session that moved under another rule
   * (its workspace was added or removed) gets a fresh grace window, so a
   * scope change never settles a long-idle session at once (spec §2). New
   * sessions need none: their anchor is their creation time.
   */
  private async trackMemberships(): Promise<void> {
    const map = this.memberships(0)
    if (map === null) return
    const domain = this.requireDomain()
    const global = domain.global.get()
    const now = Date.now()
    const previous = global.membership
    const membership: Record<string, string> = {}
    const sessionEligibleSince: Record<string, number> = {}
    let changed = false
    for (const sessionId of this.headers.keys()) {
      const workspaceId = map.get(sessionId) ?? ''
      membership[sessionId] = workspaceId
      const before = previous[sessionId]
      if (before === workspaceId) continue
      changed = true
      if (before === undefined) continue
      const from = effectivePolicy(global.policy, before === '' ? null : before)
      const to = effectivePolicy(global.policy, workspaceId === '' ? null : workspaceId)
      // Another rule: a fresh window. The same rule: the grace the former
      // workspace still owed its members moves with the session (it no longer
      // reaches the session through that workspace).
      const carried = Math.max(
        global.sessionEligibleSince[sessionId] ?? 0,
        before === '' ? 0 : global.workspaceEligibleSince[before] ?? 0,
        from.identity !== to.identity ? now : 0,
      )
      if (carried > 0) sessionEligibleSince[sessionId] = carried
    }
    for (const [sessionId, since] of Object.entries(global.sessionEligibleSince)) {
      if (sessionEligibleSince[sessionId] !== undefined || !this.headers.has(sessionId)) continue
      if (since + GRACE_RETENTION_MS > now) sessionEligibleSince[sessionId] = since
    }
    if (Object.keys(previous).length !== Object.keys(membership).length) changed = true
    if (Object.keys(sessionEligibleSince).length !== Object.keys(global.sessionEligibleSince).length) changed = true
    if (!changed) { this.membershipUnsaved = false; return }
    // Until this grace is durable, a session that changed rule must not be
    // judged under its new rule without it: the scope counts as unknown (the
    // next sweep sees the same change and retries the write).
    this.membershipUnsaved = !await domain.global.set({ ...domain.global.get(), membership, sessionEligibleSince })
      .then(() => true, () => false)
  }

  /** Workspace membership, or null when unknown (unreadable registry, or a membership grace not yet persisted). */
  private knownMemberships(maxAgeMs?: number): ReadonlyMap<string, string> | null {
    return this.membershipUnsaved ? null : this.memberships(maxAgeMs)
  }

  private async refreshHeaders(): Promise<void> {
    const persistence = optionalService<HostSessionPersistence>(this.ctx, 'sessionPersistence')
    const live = optionalService<HostLiveSessions>(this.ctx, 'sessions')
    let stored: Awaited<ReturnType<HostSessionPersistence['list']>> | null = null
    // Take the observed set *before* reading the tokens: events that commit
    // while the listing runs belong to the next refresh's comparison.
    const observed = this.observedLive
    this.observedLive = new Set()
    try {
      stored = persistence === undefined ? [] : await persistence.list()
      for (const { header } of stored) this.rememberHeader(header)
    } catch {
      // Storage faults never imply "no sessions"; keep what we already know.
    }
    for (const { header } of live?.list() ?? []) this.rememberHeader(header)
    if (stored !== null) await this.catchUpMissedActivity(stored, observed)
    else for (const sessionId of observed) this.observedLive.add(sessionId)
  }

  /**
   * Compare persistence change tokens with the ones last seen. A missing or
   * changed token only says the stored log *may* hold events this process
   * never folded (a title update or a metadata-only touch changes it too):
   *
   * - normal sessions restart their idle window now (conservative: the real
   *   activity time is unknown, but it is no later than now);
   * - parked sessions are verified by replaying their log read-only against
   *   the parking baseline ({@link verifyParked}); they stay parked until a
   *   replay proves a wake, and their token is acknowledged only once verified.
   */
  private async catchUpMissedActivity(
    stored: Awaited<ReturnType<HostSessionPersistence['list']>>, observed: ReadonlySet<string>,
  ): Promise<void> {
    await this.queue.run(async () => {
      const domain = this.requireDomain()
      const global = domain.global.get()
      const now = Date.now()
      const seen: Record<string, string> = {}
      const stale: { readonly sessionId: string; readonly token: string }[] = []
      const listed = new Set(stored.map(({ header }) => header.id))
      for (const sessionId of [...this.unverified.keys()]) if (!listed.has(sessionId)) this.unverified.delete(sessionId)
      for (const { header, revision } of stored) {
        if (header.origin === 'subagent' || revision === undefined) continue
        const token = JSON.stringify(revision)
        seen[header.id] = token
        const previous = global.seenRevisions[header.id]
        // A pending verification stays pending until a replay succeeds: live
        // events (even a title update) say nothing about the earlier history.
        if (this.failedFolds.has(header.id) || this.unverified.has(header.id)) { stale.push({ sessionId: header.id, token }); continue }
        // `observedLive` now holds events that committed while the listing ran;
        // they explain a token change too (and stay for the next comparison).
        if (observed.has(header.id) || this.observedLive.has(header.id)) continue
        const changedWhileAway = previous !== undefined
          ? previous !== token
          // Unknown to us but created after installation: possibly created while
          // we were away, or created and parked before its first refresh.
          : global.installedAt > 0 && header.createdAt > global.installedAt && Object.keys(global.seenRevisions).length > 0
        if (changedWhileAway) stale.push({ sessionId: header.id, token })
      }
      const keepPrevious = (sessionId: string): void => {
        // Not acknowledged: the next refresh compares against the old token again.
        const previous = global.seenRevisions[sessionId]
        if (previous === undefined) delete seen[sessionId]
        else seen[sessionId] = previous
      }
      for (const { sessionId, token } of stale) {
        const before = this.recordOf(sessionId, now)
        if (before.disposition.kind !== 'normal') {
          keepPrevious(sessionId)
          const pending = this.unverified.get(sessionId)
          this.unverified.set(sessionId, { token, failures: pending?.failures ?? 0, at: pending?.at ?? now })
          continue
        }
        this.unverified.delete(sessionId)
        if (before.policyEligibleSince >= now) {
          this.failedFolds.delete(sessionId)
          continue
        }
        const record: TaskRecord = { ...before, policyEligibleSince: now, revision: before.revision + 1 }
        try {
          await this.commit(record, before, 'missed-activity', null)
          this.failedFolds.delete(sessionId)
        } catch {
          // Not persisted: the next refresh detects the change again and retries.
          keepPrevious(sessionId)
        }
      }
      await domain.global.set({ ...domain.global.get(), seenRevisions: seen }).catch(() => undefined)
    }).catch(() => undefined)
    // In the background: stored-log reads can be slow and must not hold up
    // the header refresh, startup, or Snooze deadlines.
    void this.verifyDue()
  }

  /**
   * Start (or join) one verification pass over every parked session whose
   * retry instant has come, with bounded concurrency. Entries that become due
   * while a pass runs are picked up by the next sweep.
   */
  private verifyDue(): Promise<void> {
    this.verification ??= this.runVerifications().catch(() => undefined).finally(() => { this.verification = undefined })
    return this.verification
  }

  private async runVerifications(): Promise<void> {
    const now = Date.now()
    const due = [...this.unverified]
      .filter(([sessionId, entry]) => entry.at <= now && !this.verifying.has(sessionId))
      .map(([sessionId]) => sessionId)
    for (let index = 0; index < due.length && !this.disposed; index += ACTIVITY_CONCURRENCY) {
      await Promise.all(due.slice(index, index + ACTIVITY_CONCURRENCY).map(sessionId => this.verifyParked(sessionId)))
    }
  }

  /**
   * Replay one parked session's stored log read-only and read its exact
   * pending requests, then apply the ordinary wake / reopen rules against the
   * parking baseline. A read that fails leaves the task parked and retries
   * with backoff; the change token is acknowledged only after verification.
   */
  private async verifyParked(sessionId: string): Promise<void> {
    const entry = this.unverified.get(sessionId)
    if (entry === undefined || this.disposed) return
    this.verifying.add(sessionId)
    try {
      // The reads below are judged against the parking they started under.
      const baseline = JSON.stringify(this.recordOf(sessionId, Date.now()).disposition)
      const [events, pending] = await Promise.all([this.replayFoldable(sessionId), this.queryDurablePending(sessionId)])
      if (this.disposed) return
      const outcome = await this.queue.run(() => this.applyVerification(sessionId, entry.token, baseline, events, pending))
        .catch((): VerifyOutcome => 'failed')
      const current = this.unverified.get(sessionId)
      // A newer token arrived meanwhile: keep that one due for its own check.
      if (current !== undefined && current.token !== entry.token) return
      if (outcome === 'verified') {
        this.unverified.delete(sessionId)
        this.failedFolds.delete(sessionId)
      } else if (outcome === 'stale') {
        // Re-parked while the reads ran: check again (not a failure, no backoff).
        this.unverified.set(sessionId, { ...entry, at: Date.now() })
      } else {
        const failures = entry.failures + 1
        this.unverified.set(sessionId, { token: entry.token, failures, at: Date.now() + unknownRetryDelay(failures) })
      }
    } finally {
      this.verifying.delete(sessionId)
    }
  }

  /**
   * Runs inside the queue. `stale` when the parking changed since the reads
   * began (a pending answer read before the user re-parked would make an
   * already-resolved request look new and undo their command).
   */
  private async applyVerification(
    sessionId: string, token: string, baseline: string,
    events: readonly FoldableEvent[] | null, pending: Known<readonly PendingSignal[]>,
  ): Promise<VerifyOutcome> {
    const domain = this.requireDomain()
    const now = Date.now()
    const before = this.recordOf(sessionId, now)
    const since = parkedSince(before)
    let verified: boolean
    if (since === null) {
      // Reopened meanwhile; the live path owns it from here.
      verified = true
    } else if (JSON.stringify(before.disposition) !== baseline) {
      return 'stale'
    } else {
      // Events before the park were in front of the user when they parked it.
      // Apply the wake rules after every replayed event, as the live path
      // would have: a later success must not mask an earlier failure. The
      // replayed history is judged on its own (the rules compare it with the
      // parking baselines only), so a later live event already folded into
      // the stored summary cannot hide it either; the record then keeps the
      // merge of both.
      const native = this.nativeOf(sessionId)
      const wakeAt = (summary: TaskRecord['activity']): TaskRecord | null => reconcile(
        { ...before, activity: summary },
        { running: unknown, activity: this.cachedActivity({ ...before, activity: summary }), pending, summary },
        native, now,
      )
      let activity = before.activity
      let history: ActivitySummary = EMPTY_ACTIVITY
      let woken = wakeAt(activity)
      for (const event of events ?? []) {
        if (event.time < since) continue
        activity = foldActivity(activity, event)
        const folded = foldActivity(history, event)
        if (folded === history) continue
        history = folded
        woken ??= wakeAt(history)
      }
      const replayed: TaskRecord = { ...before, activity }
      const expired = before.disposition.kind === 'snoozed' && now >= before.disposition.until
      if (woken !== null) {
        // The wake is decided by the first waking prefix; the summary keeps everything replayed.
        await this.commit({ ...woken, activity }, before, expired ? 'snooze-expired' : 'missed-activity', null)
        verified = true
      } else {
        // Without a wake, verification needs both the full replay and an
        // exact pending read: either missing cannot rule a wake out.
        verified = events !== null && pending.known
        if (verified && activity !== before.activity) {
          await this.commit({ ...replayed, revision: before.revision + 1 }, before, 'missed-activity', null)
        }
      }
    }
    if (verified) {
      const global = domain.global.get()
      await domain.global.set({ ...global, seenRevisions: { ...global.seenRevisions, [sessionId]: token } }).catch(() => undefined)
    }
    return verified ? 'verified' : 'failed'
  }

  /**
   * Foldable events of one stored log, read in chunks through a `read`
   * handle (no ownership taken). Fork-inherited events are the parent's
   * history and are skipped. `null` when the log cannot be read.
   */
  private async replayFoldable(sessionId: string): Promise<FoldableEvent[] | null> {
    const persistence = optionalService<HostSessionPersistence>(this.ctx, 'sessionPersistence')
    if (persistence?.open === undefined) return null
    const signal = AbortSignal.timeout(REPLAY_TIMEOUT_MS)
    let handle: HostSessionReadHandle | undefined
    try {
      handle = await persistence.open(sessionId, 'read', { signal })
      const foldable: FoldableEvent[] = []
      for (let offset = handle.inheritedEventCount ?? 0; ;) {
        const { events } = await handle.read(offset, REPLAY_CHUNK, { signal })
        for (const event of events) {
          const reduced = toFoldable(event)
          if (reduced !== null) foldable.push(reduced)
        }
        if (events.length < REPLAY_CHUNK) return foldable
        offset += events.length
      }
    } catch {
      return null
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private rememberHeader(header: HostSessionHeader): void {
    if (header.origin === 'subagent') return
    this.headers.set(header.id, header)
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private onSessionEvent(session: HostSession, event: HostSessionEvent): void {
    if (this.disposed || this.domain === undefined) return
    if (session.header !== undefined) this.rememberHeader(session.header)
    const sessionId = session.id
    if (!this.headers.has(sessionId)) return
    // Every committed event (step progress, assistant output, …) changes the
    // persistence token; record that it was observed live even when the
    // summary does not fold it, so catch-up never mistakes it for missed work.
    this.observedLive.add(sessionId)
    const foldable = toFoldable(event)
    if (foldable === null) return
    void this.queue.run(async () => {
      const now = Date.now()
      const before = this.recordOf(sessionId, now)
      const activity = foldActivity(before.activity, foldable)
      if (activity === before.activity) return
      let record: TaskRecord = { ...before, activity, revision: before.revision + 1 }
      if (event.type !== 'user/message') await this.queryActivity(sessionId)
      if (event.type === 'turn/end') this.refreshActivitySoon(sessionId)
      const facts = this.factsOf(record, this.cachedActivity(record), null)
      record = reconcile(record, facts, this.nativeOf(sessionId), now) ?? record
      try {
        await this.commit(record, before, `activity:${event.type}`, null)
      } catch {
        // The fold is lost; let catch-up recover it conservatively instead of
        // acknowledging this session's new persistence token.
        this.failedFolds.add(sessionId)
        this.historyInvalid.add(sessionId)
        this.historyFolded.delete(sessionId)
        this.historyInvalidations.set(sessionId, (this.historyInvalidations.get(sessionId) ?? 0) + 1)
      }
    })
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────

  /** Single timer to the nearest deadline, with a 60 s fallback sweep. */
  private schedule(): void {
    if (this.disposed || this.domain === undefined) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    const now = Date.now()
    const delay = sweepDelay(this.fallbackSweepAt, nearestSnoozeDeadline(
      this.domain.table('tasks').entries(), id => this.nativeOf(id), id => this.expiryRetry.get(id)?.at,
    ), now)
    this.timer = setTimeout(() => { void this.sweep() }, delay)
  }

  /** Materialize Snooze expiries and commit due automatic settles. */
  private async sweep(): Promise<void> {
    if (this.disposed || this.domain === undefined) return
    await this.queue.run(async () => {
      const domain = this.requireDomain()
      const now = Date.now()
      const global = domain.global.get()
      // 0. Restorations from the archive get a fresh automatic-settle grace
      //    window before any settle decision below can see them.
      await this.graceRestoredSessions()
      // 1. Snooze expiry (exact deadlines).
      for (const [, record] of [...domain.table('tasks').entries()]) {
        if (record.disposition.kind !== 'snoozed') continue
        const retry = this.expiryRetry.get(record.sessionId)
        if (retry !== undefined && now < retry.at) continue
        const native = this.nativeOf(record.sessionId)
        const next = reconcile(record, this.factsOf(record, this.cachedActivity(record), null), native, now)
        if (next === null) continue
        try {
          await this.commit(next, record, 'snooze-expired', null)
          this.expiryRetry.delete(record.sessionId)
        } catch {
          // Back off so a persistent storage error cannot drive a tight sweep loop.
          const failures = (retry?.failures ?? 0) + 1
          this.expiryRetry.set(record.sessionId, { failures, at: now + unknownRetryDelay(failures) })
        }
      }
      // 2. Re-sample sessions that last reported running work (subagents, jobs,
      //    schedules); their completion emits no event this service folds.
      await this.refreshOutstandingActivity()
      // 3. Automatic settle: time pre-filter first, then fresh activity facts for due candidates.
      //    Membership is read first so a scope change grants its grace before any decision.
      await this.trackMemberships()
      const policy = domain.global.get().policy
      const anyEnabled = policy.autoSettleAfterDays !== null
        || Object.values(policy.workspaceOverrides).some(override => override.mode === 'custom')
      if (!anyEnabled) return
      const graced = domain.global.get()
      // Unknown membership with workspace overrides makes every rule unknown
      // (decideAutoSettle skips `scope-unknown`); it never falls back to the Host default.
      const membership = this.knownMemberships(0)
      const scopeKnown = membership !== null
      const keepResults = policy.keepUnacknowledgedFailures || policy.keepUnacknowledgedResults
      const due: { record: TaskRecord; header: HostSessionHeader; workspaceId: string | null }[] = []
      const needHistory: string[] = []
      for (const header of this.headers.values()) {
        const workspaceId = membership?.get(header.id) ?? null
        const record = this.withGrace(this.recordOf(header.id, now), graced, workspaceId)
        if (record.disposition.kind !== 'normal') continue
        // Time and scope only: result protections are judged after the
        // candidate's latest result is known (a cached one may be superseded).
        const timeOnly = decideAutoSettle({
          policy: { ...policy, keepUnacknowledgedFailures: false, keepUnacknowledgedResults: false },
          workspaceId,
          scopeKnown,
          record,
          facts: { running: known(false), activity: known([]), pending: known([]), summary: record.activity },
          native: { pinned: false, archived: false },
          createdAt: header.createdAt,
          now,
        })
        if (!timeOnly.eligible) continue
        // A keep protection needs the latest result; one that may predate this
        // process is rebuilt from the stored log first (off this queue), and the
        // session waits for a later sweep.
        if (keepResults && !this.resultHistoryKnown(header.id)) { needHistory.push(header.id); continue }
        due.push({ record, header, workspaceId })
      }
      if (needHistory.length > 0) this.rebuildHistory(needHistory)
      for (let index = 0; index < due.length; index += ACTIVITY_CONCURRENCY) {
        const batch = due.slice(index, index + ACTIVITY_CONCURRENCY)
        await Promise.all(batch.map(async ({ record, header, workspaceId }) => {
          const activity = await this.queryActivity(record.sessionId)
          const facts = this.factsOf(record, activity, null, await this.queryDurablePending(record.sessionId))
          const native = this.nativeOf(record.sessionId)
          const decision = decideAutoSettle({
            policy, workspaceId, scopeKnown, record,
            facts: { ...facts, resultHistoryKnown: this.resultHistoryKnown(record.sessionId) },
            native, createdAt: header.createdAt, now: Date.now(),
          })
          if (!decision.eligible || decision.deadline === null) return
          const stored = this.recordOf(record.sessionId, now)
          const settled = autoSettle(stored, facts, Date.now(), {
            anchorAt: decision.anchorAt, deadline: decision.deadline, policyRevision: policy.revision,
          })
          await this.commit(settled, stored, 'idle-timeout', {
            anchorAt: decision.anchorAt, deadline: decision.deadline, policyRevision: policy.revision,
          }).catch(() => undefined)
        }))
      }
    }).catch(() => undefined)
    this.fallbackSweepAt = Date.now() + SWEEP_MS
    this.schedule()
    // 4. Retry parked sessions whose missed-activity verification failed, off
    //    the scheduling path (the deadline timer is already armed).
    void this.verifyDue()
  }

  // ── Follow stream ─────────────────────────────────────────────────────────

  private snapshot(): Snapshot {
    const domain = this.requireDomain()
    const global = domain.global.get()
    return {
      protocolVersion: PROTOCOL_VERSION,
      installationId: global.installationId,
      epoch: this.epoch,
      streamSeq: this.streamSeq,
      dataRevision: global.dataRevision,
      serverNow: Date.now(),
      capabilities: this.capabilities,
      policy: global.policy,
      tasks: this.allViews(),
    }
  }

  /**
   * Stored records plus unstored sessions with background activity or an
   * unreadable activity answer (an
   * unstored session is an implicit revision-0 record; commands against it
   * use expectedRevision 0).
   */
  private allViews(): TaskView[] {
    const domain = this.requireDomain()
    const views = [...domain.table('tasks').entries()].map(([, record]) => this.viewOf(record))
    const stored = new Set(views.map(view => view.sessionId))
    const now = Date.now()
    for (const [sessionId, cached] of this.activityCache) {
      if (stored.has(sessionId) || !this.headers.has(sessionId)) continue
      // Sessions with background work, or whose activity could not be read: a
      // Client treats a session without any view as having nothing running.
      if (!cached.value.known || cached.value.value.length > 0) views.push(this.viewOf(this.recordOf(sessionId, now)))
    }
    return views
  }

  private publish(tasks: TaskView[], policy: TimePolicy | null): void {
    this.streamSeq += 1
    const global = this.requireDomain().global.get()
    const event: FollowEvent = {
      kind: 'delta',
      epoch: this.epoch,
      streamSeq: this.streamSeq,
      dataRevision: global.dataRevision,
      serverNow: Date.now(),
      tasks,
      policy,
    }
    for (const follower of this.followers) follower.push(event)
  }

  private openFollow(signal: AbortSignal): AsyncIterable<FollowEvent> {
    const buffer: FollowEvent[] = []
    let wake: (() => void) | undefined
    let closed: Error | null | undefined
    const follower: Follower = {
      push: (event) => {
        if (buffer.length >= FOLLOW_BUFFER) { follower.close(new Error('follower fell behind; resubscribe for a new baseline')); return }
        buffer.push(event)
        wake?.()
      },
      close: (error) => {
        closed = error ?? null
        this.followers.delete(follower)
        wake?.()
      },
    }
    // Subscribe before taking the baseline so no delta falls into the gap.
    this.followers.add(follower)
    buffer.push({ kind: 'baseline', snapshot: this.snapshot() })
    signal.addEventListener('abort', () => follower.close(), { once: true })
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<FollowEvent>> => {
          for (;;) {
            const event = buffer.shift()
            if (event !== undefined) return { done: false, value: event }
            if (closed !== undefined) {
              if (closed !== null) throw closed
              return { done: true, value: undefined }
            }
            await new Promise<void>((resolve) => { wake = resolve })
            wake = undefined
          }
        },
        return: async (): Promise<IteratorResult<FollowEvent>> => {
          follower.close()
          return { done: true, value: undefined }
        },
      }),
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    for (const timer of this.pendingTimers) clearTimeout(timer)
    this.pendingTimers.clear()
    for (const follower of [...this.followers]) follower.close()
    const domain = this.domain
    this.domain = undefined
    void this.queue.run(async () => { await domain?.close() })
  }

  private requireDomain(): Domain {
    if (this.domain === undefined) throw new Error('t3Sidebar: storage is not open')
    return this.domain
  }

  private assertProtocol(version: number): void {
    if (version !== PROTOCOL_VERSION) {
      // A typed code lets the Client tell an incompatible Host from a transient failure.
      throw new RemoteError(PROTOCOL_MISMATCH_CODE, `t3Sidebar: protocol ${version} unsupported (Host speaks ${PROTOCOL_VERSION})`,
        { client: version, host: PROTOCOL_VERSION })
    }
  }
}

/**
 * The global state after replacing the policy: enabling or shortening a
 * window starts a new grace period, but only for the sessions that rule
 * governs (the Host default's followers, or the members of a workspace whose
 * effective window became stricter). Releasing a keep-unacknowledged
 * protection is stricter for everyone: previously held results are judged
 * with a fresh window (time-policy spec §3).
 */
export function withPolicyGrace(global: GlobalState, policy: TimePolicy, now: number): GlobalState {
  const before = global.policy
  const released = (before.keepUnacknowledgedFailures && !policy.keepUnacknowledgedFailures)
    || (before.keepUnacknowledgedResults && !policy.keepUnacknowledgedResults)
  const hostFresh = released || isStricter(before.autoSettleAfterDays, policy.autoSettleAfterDays)
  const workspaceEligibleSince = { ...global.workspaceEligibleSince }
  const fresh = released
    ? Object.keys({ ...before.workspaceOverrides, ...policy.workspaceOverrides })
    : stricterWorkspaces(before, policy)
  for (const workspaceId of fresh) workspaceEligibleSince[workspaceId] = now
  return { ...global, policy, policyEligibleSince: hostFresh ? now : global.policyEligibleSince, workspaceEligibleSince }
}

/** Union of pending signals by request key (sources may differ for the same request). */
function mergePending(primary: readonly PendingSignal[], extra: readonly PendingSignal[]): PendingSignal[] {
  const keys = new Set(primary.map(signal => signal.key))
  return [...primary, ...extra.filter(signal => !keys.has(signal.key))]
}

/**
 * Pending requests from a `sessionController.projections()` answer. Only an
 * exact (`sequenced`) read can prove "none": an omitted `userQuestions` key
 * there means the capability is absent. Migration-time cache hints can only
 * add requests; a null answer (session absent) is unknown.
 */
export function durablePendingOf(read: HostProjectionsValue): Known<readonly PendingSignal[]> {
  if (read === null || typeof read !== 'object') return unknown
  const asks = (read.values?.userQuestions as { active?: readonly { callId?: unknown; state?: unknown }[] } | undefined)?.active
  const signals: PendingSignal[] = []
  for (const ask of Array.isArray(asks) ? asks : []) {
    if (typeof ask?.callId === 'string') signals.push({ source: 'userQuestions', key: ask.callId, kind: 'user-question' })
  }
  if (read.kind === 'sequenced') return known(signals)
  return signals.length > 0 ? known(signals) : unknown
}

/** Backoff before re-asking a provider that failed `failures` times: 1 min doubling, capped at 30 min. */
export function unknownRetryDelay(failures: number): number {
  return Math.min(SWEEP_MS * 2 ** Math.max(0, failures - 1), 30 * SWEEP_MS)
}

/**
 * Delay until the next sweep: the earlier of the fixed fallback instant and
 * the nearest materializable Snooze deadline (+5 ms so the deadline has passed).
 */
export function sweepDelay(fallbackAt: number, nearestSnooze: number | null, now: number): number {
  const target = nearestSnooze === null ? fallbackAt : Math.min(fallbackAt, nearestSnooze)
  return Math.min(Math.max(target - now, 0) + 5, MAX_TIMER_MS)
}

/**
 * Earliest Snooze deadline the sweep can actually materialize. Pinned and
 * archived sessions keep their Snooze frozen (reconcile leaves them alone), so
 * their deadlines must not drive the timer or it would spin on a past instant.
 */
export function nearestSnoozeDeadline(
  records: Iterable<[string, TaskRecord]>,
  nativeOf: (sessionId: string) => NativeState,
  retryAt: (sessionId: string) => number | undefined = () => undefined,
): number | null {
  let nearest: number | null = null
  for (const [, record] of records) {
    if (record.disposition.kind !== 'snoozed') continue
    const native = nativeOf(record.sessionId)
    if (native.pinned || native.archived) continue
    // A failed expiry write is not retried before its backoff instant.
    const due = Math.max(record.disposition.until, retryAt(record.sessionId) ?? 0)
    if (nearest === null || due < nearest) nearest = due
  }
  return nearest
}

type VerifyOutcome = 'verified' | 'failed' | 'stale'

/** When the current parking began, or `null` for a normal task. */
function parkedSince(record: TaskRecord): number | null {
  switch (record.disposition.kind) {
    case 'snoozed': return record.disposition.setAt
    case 'settled': return record.disposition.enteredAt
    case 'normal': return null
  }
}

/** Reduce a committed session event to what the activity summary folds. */
function toFoldable(event: HostSessionEvent): FoldableEvent | null {
  const data = event.data as Record<string, unknown> | undefined
  switch (event.type) {
    case 'turn/start':
      return { type: 'turn/start', seq: event.seq, time: event.time }
    case 'turn/end': {
      const reason = (data?.reason as { kind?: unknown } | undefined)?.kind
      return { type: 'turn/end', seq: event.seq, time: event.time, reason: typeof reason === 'string' ? reason : 'unknown' }
    }
    case 'user/message': {
      const source = (data?.source as { kind?: unknown } | undefined)?.kind
      return { type: 'user/message', seq: event.seq, time: event.time, human: source === 'user' }
    }
    default:
      return null
  }
}
