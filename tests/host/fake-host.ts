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
            if (facility.failWrites) throw new Error('disk full')
            rows.set(key, schema.parse(value))
          },
          delete: async (key: string) => rows.delete(key),
        }
      },
      global: {
        get: () => current.global ?? spec.global!.initial,
        set: async (value: unknown) => {
          if (facility.failWrites) throw new Error('disk full')
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
  headers: { id: string; createdAt: number; origin?: 'subagent' }[]
}

export function createFakeHost(storage = new MemoryDomainFacility()): FakeHost {
  const ctx = new Context()
  const registry = { pinnedSessionIds: [] as string[], archivedSessionIds: [] as string[] }
  const activity = new Map<string, string[]>()
  const headers: FakeHost['headers'] = []
  ctx.provide('storageDomain', storage)
  ctx.provide('workspaceRegistry', registry)
  ctx.provide('sessionPersistence', { list: async () => headers.map(header => ({ header })) })
  ;(ctx as unknown as { on: (name: string, fn: unknown) => void }).on('workspace/session-activity',
    async ({ sessionId }: { sessionId: string }, next: () => Promise<readonly { kind: string }[]>) =>
      [...(activity.get(sessionId) ?? []).map(kind => ({ kind })), ...await next()])
  return { ctx, storage, registry, activity, headers }
}
