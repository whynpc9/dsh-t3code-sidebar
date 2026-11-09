import { describe, expect, it } from 'vitest'
import { browserObservedWakes } from '../../src/client/wakes.ts'
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
