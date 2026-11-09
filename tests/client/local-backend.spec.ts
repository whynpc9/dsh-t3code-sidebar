import { afterEach, describe, expect, it } from 'vitest'
import { LocalBackend } from '../../src/client/backend.ts'
import { LocalRecordStore, type KeyValueStorage } from '../../src/client/local-store.ts'
import { rowStatus } from '../../src/domain/placement.ts'
import { EMPTY_ACTIVITY, known } from '../../src/domain/types.ts'

class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>()
  get length() { return this.data.size }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}

const live = {
  native: { pinned: false, archived: false },
  facts: { running: known(false), pending: known([]), activity: known([]), summary: EMPTY_ACTIVITY },
}
let backends: LocalBackend[] = []
afterEach(() => { for (const backend of backends) backend.dispose(); backends = [] })

describe('LocalBackend', () => {
  it('records a browser-observed stop as an unknown outcome, never as a successful completion', async () => {
    const backend = new LocalBackend('test', () => live, new LocalRecordStore(new MemoryStorage()))
    backends.push(backend)
    await backend.command('s1', { kind: 'reopen' }, { ...live, observedPending: [] })
    backend.observeTurn('s1', true)
    await new Promise(resolve => setTimeout(resolve, 10))
    backend.observeTurn('s1', false)
    await new Promise(resolve => setTimeout(resolve, 10))
    const summary = backend.state.getSnapshot().tasks.get('s1')!.record.activity
    expect(summary.lastTurnEnd?.reason).toBe('unknown')
    const status = rowStatus({ ...live.facts, summary }, null)
    expect(status).toBe('needs-check')
  })
})
