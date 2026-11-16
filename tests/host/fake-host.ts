/**
 * Minimal Harness Host stand-ins for the t3Sidebar service: an in-memory
 * storage-domain facility (validating records like the real one), a workspace
 * registry, session persistence, a `workspace/session-activity` provider, and
 * the Host scheduler (`ctx.schedule`).
 */
import { Context } from '@deepseek-ai/cordis'
import type { ZodType } from 'zod'

interface Spec {
  name: string
  global?: { schema: ZodType; initial: unknown }
  tables: Record<string, { valueSchema: ZodType }>
}

export class MemoryDomainFacility {
  readonly data = new Map<string, { global: unknown; tables: Map<string, Map<string, unknown>> }>()
  failWrites = false
  /** Fail only global (bookkeeping) writes, after task writes succeed. */
  failGlobalWrites = false
  /** Fail only task/transition table writes. */
  failTableWrites = false
  /** Fail only audit (transitions table) writes, after task writes succeed. */
  failAuditWrites = false
  /** When set, global writes wait for it (a slow disk). */
  globalGate: Promise<void> | null = null
  /** When set, opening a domain waits for it (slow storage at startup). */
  openGate: Promise<void> | null = null
  async open(spec: Spec) {
    if (this.openGate !== null) await this.openGate
    let unit = this.data.get(spec.name)
    if (unit === undefined) {
      unit = { global: null, tables: new Map(Object.keys(spec.tables).map(name => [name, new Map()])) }
      this.data.set(spec.name, unit)
    }
    const facility = this
    const current = unit
    return {
      table(name: string) {
        const rows = current.tables.get(name)!
        const schema = spec.tables[name]!.valueSchema
        return {
          get: (key: string) => rows.get(key),
          entries: () => rows.entries(),
          put: async (key: string, value: unknown) => {
            if (facility.failWrites || facility.failTableWrites) throw new Error('disk full')
            if (facility.failAuditWrites && name === 'transitions') throw new Error('disk full')
            rows.set(key, schema.parse(value))
          },
          delete: async (key: string) => rows.delete(key),
        }
      },
      global: {
        get: () => current.global ?? spec.global!.initial,
        set: async (value: unknown) => {
          if (facility.globalGate !== null) await facility.globalGate
          if (facility.failWrites || facility.failGlobalWrites) throw new Error('disk full')
          current.global = spec.global!.schema.parse(value)
        },
      },
      close: async () => {},
    }
  }
}

export interface FakeScheduleTask {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly timing: { readonly kind: string; readonly at?: string }
  readonly target: { readonly kind: string; readonly sessionId?: string }
}

/** In-memory `ctx.schedule`: records every create and delete. */
export class FakeSchedule {
  readonly tasks = new Map<string, FakeScheduleTask>()
  readonly created: FakeScheduleTask[] = []
  /** Ids passed to `edit({ action: 'delete' })`, in order (including failed attempts). */
  readonly deletes: string[] = []
  failCreate = false
  /** Number of upcoming delete calls that reject. */
  failDeletes = 0
  private seq = 0
  async create(request: Omit<FakeScheduleTask, 'id'>, actorSessionId?: string): Promise<FakeScheduleTask> {
    if (actorSessionId !== undefined) throw new Error('t3Sidebar acts for a human caller')
    if (this.failCreate) throw new Error('schedule store unavailable')
    if (request.timing.at === undefined || Date.parse(request.timing.at) <= Date.now()) throw new Error('target must be in the future')
    const task = { ...request, id: `schedule-${++this.seq}` }
    this.tasks.set(task.id, task)
    this.created.push(task)
    return task
  }
  async edit(request: { id: string; action: 'delete' }): Promise<{ id: string; deleted?: true; code?: string }> {
    this.deletes.push(request.id)
    if (this.failDeletes > 0) { this.failDeletes -= 1; throw new Error('schedule store unavailable') }
    return this.tasks.delete(request.id) ? { id: request.id, deleted: true } : { id: request.id, code: 'schedule_not_found' }
  }
}

export interface FakeHost {
  ctx: Context
  storage: MemoryDomainFacility
  registry: {
    pinnedSessionIds: string[]
    archivedSessionIds: string[]
    /** Workspace membership as the registry projects it (`list()`). */
    workspaces: { id: string; sessionIds: string[] }[]
    list(): readonly { id: string; sessionIds: readonly string[] }[]
  }
  activity: Map<string, string[]>
  headers: { id: string; createdAt: number; origin?: 'subagent'; revision?: string }[]
  /** Durable `userQuestions.active` per session for exact projection reads. */
  questions: Map<string, { callId: string; state: string }[]>
  /** Make exact projection reads fail (durable pending state unknown). */
  projectionsFail: boolean
  /** Runs inside `sessionPersistence.list()` before it answers (to simulate concurrent commits). */
  duringList: (() => void) | null
  /** Stored event log per session, read through `sessionPersistence.open(id, 'read')`. */
  logs: Map<string, StoredLog>
  /** Make stored-log reads fail. */
  replayFail: boolean
  /** Session ids opened for reading, in order. */
  opened: string[]
  /** When set, stored-log opens wait for it (a slow disk). */
  replayGate: Promise<void> | null
  /** The Host scheduler, or null when this Host has none. */
  schedule: FakeSchedule | null
}

export interface StoredEvent { type: string; seq: number; time: number; data: unknown }
export interface StoredLog { inherited: number; events: StoredEvent[] }

/** Append an event to a session's stored log (seq continues the log). */
export function appendStored(host: FakeHost, sessionId: string, type: string, data: unknown = {}, time = Date.now()): StoredEvent {
  let log = host.logs.get(sessionId)
  if (log === undefined) { log = { inherited: 0, events: [] }; host.logs.set(sessionId, log) }
  const event = { type, seq: log.events.length, time, data }
  log.events.push(event)
  return event
}

export function createFakeHost(storage = new MemoryDomainFacility(), options: { schedule?: boolean } = {}): FakeHost {
  const ctx = new Context()
  const registry: FakeHost['registry'] = {
    pinnedSessionIds: [], archivedSessionIds: [], workspaces: [],
    list() { return this.workspaces },
  }
  const activity = new Map<string, string[]>()
  const headers: FakeHost['headers'] = []
  const questions = new Map<string, { callId: string; state: string }[]>()
  ctx.provide('storageDomain', storage)
  ctx.provide('workspaceRegistry', registry)
  const schedule = options.schedule === false ? null : new FakeSchedule()
  if (schedule !== null) ctx.provide('schedule', schedule)
  ctx.provide('sessionController', {
    projections: async ({ sessionId }: { sessionId: string }) => {
      if (host.projectionsFail) throw new Error('history unavailable')
      return { kind: 'sequenced', asOfSeq: 1, values: { userQuestions: { active: questions.get(sessionId) ?? [], settled: [] } } }
    },
  })
  const host = {} as FakeHost
  ctx.provide('sessionPersistence', {
    list: async () => {
      await Promise.resolve()
      host.duringList?.()
      return headers.map(({ revision, ...header }) => ({ header, revision }))
    },
    open: async (id: string, access: 'read') => {
      if (access !== 'read') throw new Error('read only')
      host.opened.push(id)
      if (host.replayGate !== null) await host.replayGate
      if (host.replayFail) throw new Error('log unavailable')
      const log = host.logs.get(id) ?? { inherited: 0, events: [] }
      return {
        inheritedEventCount: log.inherited,
        read: async (offset = 0, length?: number) => {
          if (host.replayFail) throw new Error('log unavailable')
          return { events: log.events.slice(offset, length === undefined ? undefined : offset + length) }
        },
        close: async () => {},
      }
    },
  })
  ;(ctx as unknown as { on: (name: string, fn: unknown) => void }).on('workspace/session-activity',
    async ({ sessionId }: { sessionId: string }, next: () => Promise<readonly { kind: string }[]>) =>
      [...(activity.get(sessionId) ?? []).map(kind => ({ kind })), ...await next()])
  return Object.assign(host, { ctx, storage, registry, activity, headers, questions, duringList: null, projectionsFail: false, logs: new Map(), replayFail: false, opened: [], replayGate: null, schedule })
}
