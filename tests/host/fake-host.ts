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
            rows.set(key, schema.parse(value))
          },
          delete: async (key: string) => rows.delete(key),
        }
      },
      global: {
        get: () => current.global ?? spec.global!.initial,
        set: async (value: unknown) => {
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
    projections: async ({ sessionId }: { sessionId: string }) => ({
      kind: 'sequenced', asOfSeq: 1, values: { userQuestions: { active: questions.get(sessionId) ?? [], settled: [] } },
    }),
  })
  ctx.provide('sessionPersistence', { list: async () => headers.map(({ revision, ...header }) => ({ header, revision })) })
  ;(ctx as unknown as { on: (name: string, fn: unknown) => void }).on('workspace/session-activity',
    async ({ sessionId }: { sessionId: string }, next: () => Promise<readonly { kind: string }[]>) =>
      [...(activity.get(sessionId) ?? []).map(kind => ({ kind })), ...await next()])
  return { ctx, storage, registry, activity, headers, questions }
}
