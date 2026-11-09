/**
 * Browser-only task records, safe across tabs of one browser.
 *
 * Each record has its own localStorage key, so a tab can never overwrite an
 * unrelated session from a stale snapshot. Every change is a read-modify-write
 * of that one key performed inside a cross-tab Web Lock (when the browser has
 * the Locks API), so concurrent commands on the same session apply in order on
 * top of each other instead of one replacing the other.
 */
import { z } from 'zod'
import { TaskRecordSchema } from '../contracts/schema.ts'
import type { TaskRecord } from '../domain/types.ts'

export interface KeyValueStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type LockRunner = <T>(name: string, task: () => Promise<T> | T) => Promise<T>

export const RECORD_PREFIX = 't3-sidebar:v1:record:'
export const LEGACY_KEY = 't3-sidebar:v1:local-records'
const LOCK_NAME = 't3-sidebar:v1:records'

/** Web Locks when available; otherwise run in turn within this tab. */
export function defaultLockRunner(): LockRunner {
  const locks = (globalThis.navigator as { locks?: { request<T>(name: string, task: () => Promise<T> | T): Promise<T> } } | undefined)?.locks
  if (locks !== undefined) return (name, task) => locks.request(name, task)
  let tail: Promise<unknown> = Promise.resolve()
  return <T,>(_name: string, task: () => Promise<T> | T) => {
    const result = tail.then(task, task) as Promise<T>
    tail = result.catch(() => undefined)
    return result
  }
}

/** The record with the higher revision (either may be absent). */
function newer(left: TaskRecord | undefined, right: TaskRecord | undefined): TaskRecord | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return right.revision > left.revision ? right : left
}

function safeStorage(): KeyValueStorage | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

export class LocalRecordStore {
  /**
   * Records this tab could not persist (storage blocked or full). Reads merge
   * them in, so an acknowledged change is never lost by a later command; they
   * only live as long as this tab.
   */
  private readonly unpersisted = new Map<string, TaskRecord>()

  constructor(
    private readonly storage: KeyValueStorage | null = safeStorage(),
    private readonly lock: LockRunner = defaultLockRunner(),
  ) {
    this.migrateLegacy()
  }

  /** Whether a storage key belongs to this store (for `storage` events). */
  static owns(key: string | null): boolean {
    return key === null || key.startsWith(RECORD_PREFIX)
  }

  read(sessionId: string): TaskRecord | undefined {
    return newer(this.parse(this.get(RECORD_PREFIX + sessionId)), this.unpersisted.get(sessionId))
  }

  readAll(): Map<string, TaskRecord> {
    const records = new Map<string, TaskRecord>()
    if (this.storage === null) return new Map(this.unpersisted)
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index)
      if (key === null || !key.startsWith(RECORD_PREFIX)) continue
      const record = this.parse(this.get(key))
      if (record !== undefined) records.set(record.sessionId, record)
    }
    for (const [sessionId, record] of this.unpersisted) {
      const merged = newer(records.get(sessionId), record)
      if (merged !== undefined) records.set(sessionId, merged)
    }
    return records
  }

  /**
   * Serialized read-modify-write of one record. `change` receives the record
   * as currently stored (not a cached copy) and returns the replacement, or
   * null to leave it untouched.
   */
  update(sessionId: string, change: (current: TaskRecord | undefined) => TaskRecord | null): Promise<TaskRecord | null> {
    return this.lock(LOCK_NAME, () => {
      const next = change(this.read(sessionId))
      if (next === null) return null
      let persisted = false
      try {
        if (this.storage !== null) {
          this.storage.setItem(RECORD_PREFIX + sessionId, JSON.stringify(next))
          persisted = true
        }
      } catch {
        persisted = false
      }
      if (persisted) this.unpersisted.delete(sessionId)
      else this.unpersisted.set(sessionId, next)
      return next
    })
  }

  private get(key: string): string | null {
    try { return this.storage?.getItem(key) ?? null } catch { return null }
  }

  private parse(raw: string | null): TaskRecord | undefined {
    if (raw === null) return undefined
    try {
      const parsed = TaskRecordSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data as TaskRecord : undefined
    } catch {
      return undefined
    }
  }

  /** Split the earlier single-key format into per-record keys (newer records win). */
  private migrateLegacy(): void {
    const raw = this.get(LEGACY_KEY)
    if (raw === null || this.storage === null) return
    try {
      const parsed = z.record(z.string(), TaskRecordSchema).safeParse(JSON.parse(raw))
      if (parsed.success) {
        for (const [sessionId, record] of Object.entries(parsed.data)) {
          const existing = this.read(sessionId)
          if (existing === undefined || existing.revision < record.revision) {
            this.storage.setItem(RECORD_PREFIX + sessionId, JSON.stringify(record))
          }
        }
      }
      this.storage.removeItem(LEGACY_KEY)
    } catch {
      // Leave an unreadable legacy value in place rather than lose it.
    }
  }
}
