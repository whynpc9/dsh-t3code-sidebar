/**
 * Controlled stand-ins for the Client side of the `t3Sidebar` Remote: follow
 * streams the test feeds event by event, RPCs answered through deferred
 * promises, and snapshot/task builders.
 */
import type { CommandResult, FollowEvent, PolicyResult, Snapshot, TaskView } from '../../src/contracts/schema.ts'
import type { FollowStream, RemoteResult, T3Remote } from '../../src/client/backend.ts'
import { EMPTY_ACTIVITY, emptyRecord, type TimePolicy } from '../../src/domain/types.ts'

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

/** Let queued microtasks and immediately-due work run. */
export const flush = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>(resolve => queueMicrotask(resolve))
}

/**
 * A follow stream fed by the test. `honorAbort: false` models a dead
 * connection whose stream keeps delivering (or never ends) after the client
 * gave up on it.
 */
export class FakeStream implements FollowStream {
  private readonly buffer: FollowEvent[] = []
  private wake: (() => void) | undefined
  private ended: { error: unknown } | null = null
  aborted = false
  disposed = false

  constructor(signal: AbortSignal | undefined, private readonly honorAbort: boolean) {
    signal?.addEventListener('abort', () => {
      this.aborted = true
      if (this.honorAbort) this.end()
    }, { once: true })
  }

  push(event: FollowEvent): void { this.buffer.push(event); this.wake?.() }
  end(error?: unknown): void { this.ended = { error }; this.wake?.() }
  dispose(): void { this.disposed = true; if (this.honorAbort) this.end() }

  [Symbol.asyncIterator](): AsyncIterator<FollowEvent> {
    return {
      next: async () => {
        for (;;) {
          const event = this.buffer.shift()
          if (event !== undefined) return { done: false, value: event }
          if (this.ended !== null) {
            if (this.ended.error !== undefined) throw this.ended.error
            return { done: true, value: undefined }
          }
          await new Promise<void>((resolve) => { this.wake = resolve })
          this.wake = undefined
        }
      },
      return: async () => ({ done: true, value: undefined }),
    }
  }
}

export const POLICY: TimePolicy = { revision: 0, autoSettleAfterDays: 7, keepUnacknowledgedFailures: false, keepUnacknowledgedResults: false, workspaceOverrides: {} }

export function taskView(sessionId: string, revision: number, kind: 'normal' | 'settled' = 'normal'): TaskView {
  const base = { ...emptyRecord(sessionId, 0), activity: EMPTY_ACTIVITY, revision }
  const record = kind === 'normal' ? base : {
    ...base,
    disposition: {
      kind: 'settled' as const, reason: 'manual' as const, enteredAt: 0,
      baselineTurnStartSeq: null, baselineUserInputAt: null, baselinePending: [],
    },
  }
  return { sessionId, record, activity: null, autoSettleDeadline: null, autoSettleSkip: null }
}

export function snapshot(epoch: string, streamSeq: number, tasks: TaskView[] = [], policy: TimePolicy = POLICY): Snapshot {
  return {
    protocolVersion: 1, installationId: 'install', epoch, streamSeq, dataRevision: 0, serverNow: Date.now(),
    capabilities: { hostActivity: true, sessionEvents: true, hostPending: false }, policy, tasks,
  }
}

export const baseline = (epoch: string, streamSeq: number, tasks: TaskView[] = [], policy: TimePolicy = POLICY): FollowEvent =>
  ({ kind: 'baseline', snapshot: snapshot(epoch, streamSeq, tasks, policy) })

export const delta = (epoch: string, streamSeq: number, tasks: TaskView[] = [], policy: TimePolicy | null = null): FollowEvent =>
  ({ kind: 'delta', epoch, streamSeq, dataRevision: 0, serverNow: Date.now(), tasks, policy })

/** A T3Remote whose every call is recorded and answered by the test. */
export class FakeRemote implements T3Remote {
  readonly streams: FakeStream[] = []
  readonly commands: { input: Record<string, unknown>; reply: Deferred<RemoteResult<CommandResult>> }[] = []
  readonly policies: { input: Record<string, unknown>; reply: Deferred<RemoteResult<PolicyResult>> }[] = []
  snapshotReply: () => Promise<RemoteResult<Snapshot>> = async () => ({ ok: true, value: snapshot('e1', 0) })
  honorAbort = true

  async getSnapshot(): Promise<RemoteResult<Snapshot>> { return await this.snapshotReply() }

  follow(_version: number, signal?: AbortSignal): FollowStream {
    const stream = new FakeStream(signal, this.honorAbort)
    this.streams.push(stream)
    return stream
  }

  async command(input: unknown): Promise<RemoteResult<CommandResult>> {
    const reply = deferred<RemoteResult<CommandResult>>()
    this.commands.push({ input: input as Record<string, unknown>, reply })
    return await reply.promise
  }

  async setPolicy(input: unknown): Promise<RemoteResult<PolicyResult>> {
    const reply = deferred<RemoteResult<PolicyResult>>()
    this.policies.push({ input: input as Record<string, unknown>, reply })
    return await reply.promise
  }

  async listTransitions() { return { ok: true, value: [] } }

  get stream(): FakeStream {
    const last = this.streams.at(-1)
    if (last === undefined) throw new Error('no stream opened')
    return last
  }
}

/** A `connection/reset` source the test fires. */
export class ResetSource {
  readonly listeners = new Set<() => void>()
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  fire(): void { for (const listener of [...this.listeners]) listener() }
}
