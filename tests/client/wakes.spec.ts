import { describe, expect, it } from 'vitest'
import { browserObservedWakes, WakeDispatcher } from '../../src/client/wakes.ts'
import type { CommandResult } from '../../src/contracts/schema.ts'
import type { TaskView } from '../../src/contracts/schema.ts'
import { EMPTY_ACTIVITY, emptyRecord, known, type PendingSignal } from '../../src/domain/types.ts'

const NOW = Date.UTC(2026, 10, 9, 12)
const view = (sessionId: string, baselinePending: string[]): TaskView => ({
  sessionId,
  record: {
    ...emptyRecord(sessionId, 0),
    revision: 3,
    disposition: { kind: 'snoozed', until: NOW + 3_600_000, setAt: NOW - 1000, baselinePending, baselineTurnEndSeq: null, baselineUserInputAt: null },
  },
  activity: [], autoSettleDeadline: null, autoSettleSkip: null,
})
const facts = (pending: PendingSignal[]) => ({
  native: { pinned: false, archived: false },
  facts: { running: known(true), pending: known(pending), activity: known(['turn']), summary: EMPTY_ACTIVITY },
})

describe('browserObservedWakes', () => {
  it('reports a snoozed task that received a new approval, but not one with only its baseline request', () => {
    const tasks = new Map([['a', view('a', [])], ['b', view('b', ['live:q1'])]])
    const signals: Record<string, PendingSignal[]> = {
      a: [{ source: 'live', key: 'ap1', kind: 'approval' }],
      b: [{ source: 'live', key: 'q1', kind: 'user-question' }],
    }
    expect(browserObservedWakes(tasks, id => facts(signals[id] ?? []), NOW)).toEqual([{ sessionId: 'a', revision: 3 }])
  })

  it('does not treat a known question that switched source as a new request', () => {
    const tasks = new Map([['b', view('b', ['live:q1'])]])
    const moved = facts([{ source: 'userQuestions', key: 'q1', kind: 'user-question' }])
    expect(browserObservedWakes(tasks, () => moved, NOW)).toEqual([])
  })

  it('ignores pinned sessions and leaves expiry to the Host', () => {
    const tasks = new Map([['a', view('a', [])]])
    const pinned = { ...facts([{ source: 'live', key: 'ap1', kind: 'approval' }]), native: { pinned: true, archived: false } }
    expect(browserObservedWakes(tasks, () => pinned, NOW)).toEqual([])
    expect(browserObservedWakes(tasks, () => facts([]), NOW + 4_000_000)).toEqual([])
  })
})

describe('WakeDispatcher', () => {
  const ok: CommandResult = { ok: true, task: null as never, dataRevision: 0, replayed: false }
  const fail = (code: 'STORAGE_UNAVAILABLE' | 'CONFLICT'): CommandResult => ({ ok: false, code, message: code, task: null })
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  function harness(results: (CommandResult | Error)[]) {
    const sent: string[] = []
    const timers: { task: () => void; delay: number }[] = []
    const dispatcher = new WakeDispatcher(async (wake) => {
      sent.push(wake.sessionId)
      const next = results.shift() ?? ok
      if (next instanceof Error) throw next
      return next
    }, (task, delay) => { timers.push({ task, delay }); return () => {} })
    return { dispatcher, sent, timers }
  }
  const wake = { sessionId: 's1', revision: 4 }

  it('sends once per revision after success', async () => {
    const { dispatcher, sent, timers } = harness([ok])
    dispatcher.sync([wake]); dispatcher.sync([wake])
    await flush()
    dispatcher.sync([wake])
    expect(sent).toEqual(['s1'])
    expect(timers).toHaveLength(0)
  })

  it('retries transient failures and thrown errors with backoff until persisted', async () => {
    const { dispatcher, sent, timers } = harness([fail('STORAGE_UNAVAILABLE'), new Error('socket closed'), ok])
    dispatcher.sync([wake])
    await flush()
    expect(timers.map(timer => timer.delay)).toEqual([1000])
    timers[0]!.task(); await flush()
    expect(timers.map(timer => timer.delay)).toEqual([1000, 2000])
    timers[1]!.task(); await flush()
    expect(sent).toEqual(['s1', 's1', 's1'])
    dispatcher.sync([wake])
    expect(sent).toHaveLength(3)
  })

  it('does not retry a definitive rejection or a wake that is no longer wanted', async () => {
    const conflict = harness([fail('CONFLICT')])
    conflict.dispatcher.sync([wake]); await flush()
    expect(conflict.timers).toHaveLength(0)
    const gone = harness([fail('STORAGE_UNAVAILABLE')])
    gone.dispatcher.sync([wake]); await flush()
    gone.dispatcher.sync([])
    gone.timers[0]!.task(); await flush()
    expect(gone.sent).toEqual(['s1'])
  })

  it('keeps retrying every failed wake when several fail during the same outage', async () => {
    const { dispatcher, sent, timers } = harness([fail('STORAGE_UNAVAILABLE'), fail('STORAGE_UNAVAILABLE'), ok, ok])
    const other = { sessionId: 's2', revision: 7 }
    dispatcher.sync([wake, other])
    await flush()
    expect(timers).toHaveLength(2)
    timers[0]!.task(); await flush()
    timers[1]!.task(); await flush()
    expect(sent).toEqual(['s1', 's2', 's1', 's2'])
  })
})
