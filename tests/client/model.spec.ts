import { describe, expect, it } from 'vitest'
import { archivedRows, buildRows, currentHiddenByFilter, projectGroups, projectRank, taskSections, type ModelInputs, type SessionRow } from '../../src/client/model.ts'
import type { TaskView } from '../../src/contracts/schema.ts'
import { emptyRecord } from '../../src/domain/types.ts'

const NOW = Date.UTC(2026, 10, 9, 12)
const session = (id: string, patch: Partial<SessionRow> = {}): SessionRow => ({
  id, displayTitle: `Title ${id}`, title: `Title ${id}`, running: false, blank: false, updatedAt: NOW - 1000, retainedBy: {}, ...patch,
})

function inputs(patch: Partial<ModelInputs> = {}): ModelInputs {
  const rows = [
    session('a'),
    session('b', { running: true }),
    session('c'),
    session('d'),
    session('sub', { origin: 'subagent', parentId: 'a' }),
    session('blank', { blank: true }),
    session('cur', { blank: true, retainedBy: { mainView: 1 } }),
  ]
  const snoozed: TaskView = {
    sessionId: 'c',
    record: { ...emptyRecord('c', 0), revision: 1, disposition: { kind: 'snoozed', until: NOW + 3_600_000, setAt: NOW, baselinePending: [], baselineTurnEndSeq: null, baselineUserInputAt: null } },
    activity: [], autoSettleDeadline: null, autoSettleSkip: null,
  }
  return {
    sessions: { ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])), phase: 'ready' },
    workspaces: {
      items: [{ workspaceId: 'w1', path: '/p/one', title: 'One', sessionIds: ['a', 'b'] }, { workspaceId: 'w2', path: '/p/two', title: 'Two', sessionIds: [] }],
      pinnedSessionIds: ['d'],
      archivedSessionIds: ['zzz'],
      phase: 'ready',
    },
    status: new Map([['a', { running: false, pendingInteraction: { key: 'k1', kind: 'approval' }, completionUnread: false }]]),
    tasks: new Map([['c', snoozed]]),
    lastSeen: {},
    now: NOW,
    ...patch,
  }
}

describe('view model', () => {
  it('places each top-level session exactly once and hides subagents and non-current blanks', () => {
    const rows = buildRows(inputs())
    expect(rows.map(row => row.sessionId).sort()).toEqual(['a', 'b', 'c', 'cur', 'd'])
    const sections = Object.fromEntries(taskSections(rows, { scope: null, query: '', contentHits: null }).map(s => [s.placement, s.rows.map(r => r.sessionId)]))
    expect(sections).toEqual({ pinned: ['d'], active: expect.arrayContaining(['a', 'cur']), working: ['b'], snoozed: ['c'], settled: [] })
    const all = Object.values(sections).flat()
    expect(new Set(all).size).toBe(all.length)
    expect(rows.find(row => row.sessionId === 'a')?.status).toBe('approval')
  })

  it('filters by project scope, ungrouped and title query', () => {
    const rows = buildRows(inputs())
    const scoped = taskSections(rows, { scope: 'w1', query: '', contentHits: null }).flatMap(s => s.rows.map(r => r.sessionId))
    expect(scoped.sort()).toEqual(['a', 'b'])
    const ungrouped = taskSections(rows, { scope: 'ungrouped', query: '', contentHits: null }).flatMap(s => s.rows.map(r => r.sessionId))
    expect(ungrouped.sort()).toEqual(['c', 'cur', 'd'])
    const query = taskSections(rows, { scope: null, query: 'title b', contentHits: null }).flatMap(s => s.rows.map(r => r.sessionId))
    expect(query).toEqual(['b'])
    const content = taskSections(rows, { scope: null, query: 'zebra', contentHits: new Set(['d']) }).flatMap(s => s.rows.map(r => r.sessionId))
    expect(content).toEqual(['d'])
  })

  it('groups projects in Host order, keeps empty projects and parks later rows', () => {
    const rows = buildRows(inputs())
    const groups = projectGroups(rows, inputs().workspaces, { scope: null, query: '', contentHits: null }, 'Ungrouped')
    expect(groups.map(group => group.title)).toEqual(['One', 'Two', 'Ungrouped'])
    expect(groups[1]!.primary).toHaveLength(0)
    const ungrouped = groups[2]!
    expect(ungrouped.later.map(row => row.sessionId)).toEqual(['c'])
    expect(ungrouped.primary[0]!.sessionId).toBe('d')
  })

  it('lists archived sessions separately from the five sections', () => {
    const base = inputs()
    const rows = buildRows({ ...base, workspaces: { ...base.workspaces, archivedSessionIds: ['a'] } })
    expect(rows.find(row => row.sessionId === 'a')?.placement).toBeNull()
    expect(archivedRows(rows, { scope: null, query: '', contentHits: null }).map(row => row.sessionId)).toEqual(['a'])
  })
})

describe('projectRank', () => {
  it('orders pinned, attention, working, ordinary active, snoozed, settled', () => {
    const rows = [
      { id: 'idle', placement: 'active', status: 'idle' },
      { id: 'run', placement: 'working', status: 'running' },
      { id: 'ask', placement: 'active', status: 'approval' },
      { id: 'pin', placement: 'pinned', status: 'idle' },
      { id: 'late', placement: 'settled', status: 'idle' },
      { id: 'snz', placement: 'snoozed', status: 'idle' },
      { id: 'res', placement: 'active', status: 'new-result' },
    ] as const
    const order = [...rows].sort((a, b) => projectRank(a) - projectRank(b)).map(row => row.id)
    expect(order).toEqual(['pin', 'ask', 'res', 'run', 'idle', 'snz', 'late'])
  })

  it('places a Working session above an idle Active one inside a project group', () => {
    const base = inputs()
    const rows = buildRows({ ...base, status: new Map() })
    const one = projectGroups(rows, base.workspaces, { scope: 'w1', query: '', contentHits: null }, 'Ungrouped')[0]!
    expect(one.primary.map(row => row.sessionId)).toEqual(['b', 'a'])
  })
})

describe('currentHiddenByFilter', () => {
  it('flags the current session when a search or scope excludes it, and not otherwise', () => {
    const rows = buildRows(inputs())
    const current = rows.find(row => row.current)
    expect(current?.sessionId).toBe('cur')
    expect(currentHiddenByFilter(current, { scope: null, query: '', contentHits: null })).toBe(false)
    expect(currentHiddenByFilter(current, { scope: null, query: 'title b', contentHits: null })).toBe(true)
    expect(currentHiddenByFilter(current, { scope: 'w1', query: '', contentHits: null })).toBe(true)
    expect(currentHiddenByFilter(current, { scope: null, query: 'title cur', contentHits: null })).toBe(false)
  })
})
