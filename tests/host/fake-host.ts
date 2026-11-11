/**
 * Minimal Harness Host stand-ins for the t3Sidebar service: an in-memory
 * storage-domain facility (validating records like the real one), a workspace
 * registry, session persistence, and a `workspace/session-activity` provider.
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
  async open(spec: Spec) {
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

export interface FakeHost {
  ctx: Context
  storage: MemoryDomainFacility
  registry: { pinnedSessionIds: string[]; archivedSessionIds: string[] }
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

export function createFakeHost(storage = new MemoryDomainFacility()): FakeHost {
  const ctx = new Context()
  const registry = { pinnedSessionIds: [] as string[], archivedSessionIds: [] as string[] }
  const activity = new Map<string, string[]>()
  const headers: FakeHost['headers'] = []
  const questions = new Map<string, { callId: string; state: string }[]>()
  ctx.provide('storageDomain', storage)
  ctx.provide('workspaceRegistry', registry)
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
  return Object.assign(host, { ctx, storage, registry, activity, headers, questions, duringList: null, projectionsFail: false, logs: new Map(), replayFail: false, opened: [], replayGate: null })
}
