import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('applies off-peak snoozes only at an off-peak boundary and stores the origin', async () => {
    const storage = new MemoryStorage()
    const backend = new LocalBackend('test', () => live, new LocalRecordStore(storage))
    backends.push(backend)
    const now = Date.UTC(2027, 2, 1, 7) // Monday 07:00 UTC, inside the 06:00–10:00 peak
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const context = { ...live, observedPending: [] }
      const off = Date.UTC(2027, 2, 1, 10)
      expect(await backend.command('s1', { kind: 'snooze', until: off - 60_000, origin: 'off-peak' }, context))
        .toMatchObject({ ok: false, code: 'INVALID_TIME' })
      expect(await backend.command('s1', { kind: 'snooze', until: off, origin: 'off-peak' }, context))
        .toMatchObject({ ok: true })
      expect(backend.state.getSnapshot().tasks.get('s1')!.record.disposition).toMatchObject({ kind: 'snoozed', until: off, origin: 'off-peak' })
      expect([...storage.data.values()].some(value => value.includes('"origin":"off-peak"'))).toBe(true)
      expect(await backend.command('s2', { kind: 'snooze', until: off - 60_000 }, context)).toMatchObject({ ok: true })
      expect('origin' in backend.state.getSnapshot().tasks.get('s2')!.record.disposition).toBe(false)
      // No scheduler in a browser: resuming is refused and nothing changes.
      expect(await backend.command('s3', { kind: 'snooze', until: off, origin: 'off-peak', resume: { prompt: 'Continue.' } }, context))
        .toMatchObject({ ok: false, code: 'SCHEDULE_UNAVAILABLE' })
      expect(backend.state.getSnapshot().tasks.has('s3')).toBe(false)
    } finally {
      clock.mockRestore()
    }
  })
})
