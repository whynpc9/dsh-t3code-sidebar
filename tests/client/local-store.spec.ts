import { describe, expect, it } from 'vitest'
import { LEGACY_KEY, LocalRecordStore, RECORD_PREFIX, type KeyValueStorage, type LockRunner } from '../../src/client/local-store.ts'
import { emptyRecord, type TaskRecord } from '../../src/domain/types.ts'

class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>()
  get length() { return this.data.size }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}

/** One lock shared by "tabs", like navigator.locks within a browser profile. */
function sharedLock(): LockRunner {
  let tail: Promise<unknown> = Promise.resolve()
  return <T,>(_name: string, task: () => Promise<T> | T) => {
    const result = tail.then(task, task) as Promise<T>
    tail = result.catch(() => undefined)
    return result
  }
}

const snoozed = (record: TaskRecord): TaskRecord => ({
  ...record, revision: record.revision + 1,
  disposition: { kind: 'snoozed', until: 10, setAt: 1, baselinePending: [], baselineTurnEndSeq: null, baselineUserInputAt: null },
})
const settled = (record: TaskRecord): TaskRecord => ({
  ...record, revision: record.revision + 1,
  disposition: { kind: 'settled', reason: 'manual', enteredAt: 1, baselineTurnStartSeq: null, baselineUserInputAt: null, baselinePending: [] },
})

describe('LocalRecordStore', () => {
  it('two tabs writing different sessions from stale snapshots keep both changes', async () => {
    const storage = new MemoryStorage()
    const lock = sharedLock()
    const tabA = new LocalRecordStore(storage, lock)
    const tabB = new LocalRecordStore(storage, lock)
    tabA.readAll(); tabB.readAll() // both start from the same (empty) snapshot
    await Promise.all([
      tabA.update('s1', current => snoozed(current ?? emptyRecord('s1', 0))),
      tabB.update('s2', current => settled(current ?? emptyRecord('s2', 0))),
    ])
    const all = new LocalRecordStore(storage, lock).readAll()
    expect(all.get('s1')?.disposition.kind).toBe('snoozed')
    expect(all.get('s2')?.disposition.kind).toBe('settled')
  })

  it('concurrent commands on the same session apply on top of each other', async () => {
    const storage = new MemoryStorage()
    const lock = sharedLock()
    const tabA = new LocalRecordStore(storage, lock)
    const tabB = new LocalRecordStore(storage, lock)
    await Promise.all([
      tabA.update('s1', current => snoozed(current ?? emptyRecord('s1', 0))),
      tabB.update('s1', current => settled(current ?? emptyRecord('s1', 0))),
    ])
    expect(tabA.read('s1')).toMatchObject({ revision: 2, disposition: { kind: 'settled' } })
  })

  it('migrates the earlier single-key format into per-record keys', () => {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_KEY, JSON.stringify({ s1: snoozed(emptyRecord('s1', 0)) }))
    const store = new LocalRecordStore(storage, sharedLock())
    expect(storage.getItem(LEGACY_KEY)).toBeNull()
    expect(storage.getItem(`${RECORD_PREFIX}s1`)).not.toBeNull()
    expect(store.read('s1')?.disposition.kind).toBe('snoozed')
  })
})
