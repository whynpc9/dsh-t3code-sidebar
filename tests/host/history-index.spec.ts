import { afterEach, describe, expect, it } from 'vitest'
import { HistoryIndex, type HistorySource } from '../../src/host/history-index.ts'
import type { HistoryEvent } from '../../src/domain/history-text.ts'

interface FakeSession { createdAt: number; token: string; events: HistoryEvent[]; fail?: boolean }

const message = (seq: number, text: string, role: 'user' | 'assistant' = 'user'): HistoryEvent => role === 'user'
  ? { type: 'user/message', seq, time: 1000 * seq, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
  : { type: 'assistant/message', seq, time: 1000 * seq, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text }] } } }
const boundary = (seq: number): HistoryEvent => ({ type: 'turn/end', seq, time: 1000 * seq, data: { reason: { kind: 'completed' } } })

function fakeSource(sessions: Map<string, FakeSession>) {
  const reads: { id: string; offset: number }[] = []
  let lists = 0
  let gate: Promise<void> | null = null
  const source: HistorySource = {
    async list() {
      lists++
      return [...sessions].map(([id, session]) => ({ id, createdAt: session.createdAt, token: session.token }))
    },
    async read(id, offset) {
      reads.push({ id, offset })
      if (gate !== null) await gate
      const session = sessions.get(id)
      if (session === undefined || session.fail === true) return null
      return session.events.slice(offset)
    },
  }
  return {
    source, reads,
    get lists() { return lists },
    hold() { let release!: () => void; gate = new Promise((resolve) => { release = resolve }); return () => { gate = null; release() } },
  }
}

const signal = () => new AbortController().signal
let indexes: HistoryIndex[] = []
const create = (source: HistorySource, options: ConstructorParameters<typeof HistoryIndex>[1] = {}) => {
  const index = new HistoryIndex(source, { waitMs: 5_000, ...options })
  indexes.push(index)
  return index
}
afterEach(() => { for (const index of indexes) index.dispose(); indexes = [] })

describe('HistoryIndex', () => {
  it('does nothing until the first search, then finds every session including the oldest', async () => {
    const sessions = new Map<string, FakeSession>()
    for (let i = 0; i < 300; i++) {
      sessions.set(`s${i}`, { createdAt: i, token: 't1', events: [message(0, `filler ${i}`), boundary(1), message(2, `reply ${i}`, 'assistant')] })
    }
    sessions.get('s0')!.events.push(message(3, '最旧的唯一命中 needle'))
    const fake = fakeSource(sessions)
    const index = create(fake.source)
    expect(fake.lists).toBe(0)
    expect(index.active).toBe(false)
    const result = await index.search('NEEDLE', 50, signal())
    expect(result).toMatchObject({ complete: true, progress: null, hasMore: false })
    expect(result.hits).toEqual([{ sessionId: 's0', seq: 3, at: 3000, role: 'user', snippet: '最旧的唯一命中 needle', highlight: [8, 14] }])
    // One- and two-character CJK queries scan everything too.
    expect((await index.search('旧', 50, signal())).hits.map(hit => hit.sessionId)).toEqual(['s0'])
    expect((await index.search('reply 29', 50, signal())).hits.map(hit => hit.sessionId).sort()).toEqual(['s29', 's290', 's291', 's292', 's293', 's294', 's295', 's296', 's297', 's298', 's299'].sort())
  })

  it('orders by the matching message time, caps the page and reports more', async () => {
    const sessions = new Map<string, FakeSession>([
      ['old', { createdAt: 1, token: 't', events: [message(0, 'match early'), message(1, 'other')] }],
      ['new', { createdAt: 0, token: 't', events: [message(0, 'x'), message(1, 'x'), message(5, 'match late')] }],
      ['mid', { createdAt: 2, token: 't', events: [message(0, 'x'), message(3, 'match mid')] }],
    ])
    const index = create(fakeSource(sessions).source)
    const result = await index.search('match', 2, signal())
    expect(result.hits.map(hit => hit.sessionId)).toEqual(['new', 'mid'])
    expect(result.hasMore).toBe(true)
  })

  it('reads only new events when a token changes, and drops deleted sessions', async () => {
    const sessions = new Map<string, FakeSession>([
      ['a', { createdAt: 1, token: 't1', events: [message(0, 'first')] }],
      ['b', { createdAt: 2, token: 't1', events: [message(0, 'gone soon')] }],
    ])
    const fake = fakeSource(sessions)
    let now = 0
    const index = create(fake.source, { refreshMs: 10, now: () => now })
    await index.search('first', 10, signal())
    sessions.get('a')!.events.push(boundary(1), message(2, 'second'))
    sessions.get('a')!.token = 't2'
    sessions.delete('b')
    now = 100
    fake.reads.length = 0
    const result = await index.search('second', 10, signal())
    expect(fake.reads).toEqual([{ id: 'a', offset: 1 }])
    expect(result.hits.map(hit => hit.sessionId)).toEqual(['a'])
    expect((await index.search('gone', 10, signal())).hits).toEqual([])
    // Unchanged tokens are not read again within the refresh window or after it.
    now = 200
    fake.reads.length = 0
    await index.search('first', 10, signal())
    expect(fake.reads).toEqual([])
  })

  it('re-reads a whole log when an incremental read does not continue it', async () => {
    const sessions = new Map<string, FakeSession>([['a', { createdAt: 1, token: 't1', events: [message(0, 'before'), message(1, 'old words')] }]])
    const fake = fakeSource(sessions)
    let now = 0
    const index = create(fake.source, { refreshMs: 10, now: () => now })
    await index.search('old', 10, signal())
    // The log was rewritten (repair): the events after the old offset do not continue at the expected seq.
    sessions.get('a')!.events = [message(10, 'before'), message(11, 'new words'), message(12, 'x'), message(13, 'more')]
    sessions.get('a')!.token = 't2'
    now = 100
    fake.reads.length = 0
    expect((await index.search('new words', 10, signal())).hits).toHaveLength(1)
    expect(fake.reads).toEqual([{ id: 'a', offset: 2 }, { id: 'a', offset: 0 }])
    expect((await index.search('old words', 10, signal())).hits).toHaveLength(0)
  })

  it('periodically re-reads whole logs', async () => {
    const sessions = new Map<string, FakeSession>([['a', { createdAt: 1, token: 't1', events: [message(0, 'same')] }]])
    const fake = fakeSource(sessions)
    let now = 0
    const index = create(fake.source, { refreshMs: 10, fullReadMs: 1000, now: () => now })
    await index.search('same', 10, signal())
    now = 2000
    fake.reads.length = 0
    await index.search('same', 10, signal())
    expect(fake.reads).toEqual([{ id: 'a', offset: 0 }])
  })

  it('indexes live messages of sessions already read and lists new sessions', async () => {
    const sessions = new Map<string, FakeSession>([['a', { createdAt: 1, token: 't1', events: [message(0, 'hello')] }]])
    const fake = fakeSource(sessions)
    const index = create(fake.source, { refreshMs: 60_000 })
    await index.search('hello', 10, signal())
    index.observe('a', message(1, 'live words', 'assistant'))
    // A gap (missed event) is not appended; the next read catches up.
    index.observe('a', message(5, 'skipped words'))
    expect((await index.search('live', 10, signal())).hits).toMatchObject([{ sessionId: 'a', role: 'assistant', seq: 1 }])
    expect((await index.search('skipped', 10, signal())).hits).toEqual([])
    index.observe('new', message(0, 'brand new'))
    expect(await index.search('brand', 10, signal())).toMatchObject({ hits: [], complete: false, progress: { indexed: 1, total: 2 } })
  })

  it('answers partially while sessions are still being read', async () => {
    const sessions = new Map<string, FakeSession>([
      ['a', { createdAt: 1, token: 't', events: [message(0, 'needle')] }],
      ['b', { createdAt: 2, token: 't', events: [message(0, 'needle')] }],
    ])
    const fake = fakeSource(sessions)
    const release = fake.hold()
    const index = create(fake.source, { waitMs: 10 })
    expect(await index.search('needle', 10, signal())).toMatchObject({ hits: [], complete: false, progress: { indexed: 0, total: 2 } })
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    const result = await index.search('needle', 10, signal())
    expect(result).toMatchObject({ complete: true, progress: null })
    expect(result.hits).toHaveLength(2)
  })

  it('reports unreadable sessions as incomplete and retries them', async () => {
    const sessions = new Map<string, FakeSession>([
      ['a', { createdAt: 1, token: 't', events: [message(0, 'needle')] }],
      ['b', { createdAt: 2, token: 't', events: [message(0, 'needle')], fail: true }],
    ])
    let now = 0
    const index = create(fakeSource(sessions).source, { refreshMs: 10, now: () => now })
    expect(await index.search('needle', 10, signal())).toMatchObject({ complete: false, progress: { indexed: 1, total: 2 } })
    sessions.get('b')!.fail = false
    now = 100
    const result = await index.search('needle', 10, signal())
    expect(result).toMatchObject({ complete: true })
    expect(result.hits).toHaveLength(2)
  })

  it('stops on abort and frees memory when idle', async () => {
    const sessions = new Map<string, FakeSession>([['a', { createdAt: 1, token: 't', events: [message(0, 'needle')] }]])
    const fake = fakeSource(sessions)
    const index = create(fake.source, { idleMs: 20 })
    const controller = new AbortController()
    controller.abort()
    await expect(index.search('needle', 10, controller.signal)).rejects.toThrow()
    await index.search('needle', 10, signal())
    expect(index.active).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(index.active).toBe(false)
    expect((await index.search('needle', 10, signal())).hits).toHaveLength(1)
    expect(fake.lists).toBe(2)
  })
})
