import { describe, expect, it } from 'vitest'
import {
  buildRows, flatRows, requiredWatermark, sanitizeQuery, searchResults, statusSections, watermarkRows, workspaceGroups,
  WATERMARK_BASE, type ModelInputs, type Row, type SessionRow,
} from '../../src/client/model.ts'
import { migratePrefs, DEFAULT_PREFS } from '../../src/client/runtime.ts'
import { quickActionOf } from '../../src/client/components/Rows.tsx'
import type { TaskView } from '../../src/contracts/schema.ts'
import { EMPTY_ACTIVITY, emptyRecord, known } from '../../src/domain/types.ts'

const NOW = Date.UTC(2026, 10, 9, 12)
const session = (id: string, patch: Partial<SessionRow> = {}): SessionRow => ({
  id, displayTitle: `Title ${id}`, title: `Title ${id}`, running: false, blank: false, updatedAt: NOW - 1000, retainedBy: {}, ...patch,
})

function inputs(patch: Partial<ModelInputs> = {}): ModelInputs {
  const rows = [
    session('a', { updatedAt: NOW - 5000 }),
    session('b', { running: true, updatedAt: NOW - 1000 }),
    session('c', { updatedAt: NOW - 3000 }),
    session('d', { updatedAt: NOW - 9000 }),
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

const ids = (rows: readonly Row[]) => rows.map(row => row.sessionId)

describe('rows', () => {
  it('builds each top-level session once, hides subagents and non-current blanks, and keeps list facts', () => {
    const rows = buildRows(inputs())
    expect(ids(rows).sort()).toEqual(['a', 'b', 'c', 'cur', 'd'])
    expect(rows.find(row => row.sessionId === 'a')).toMatchObject({ status: 'approval', updatedAt: NOW - 5000, blank: false })
    expect(rows.find(row => row.sessionId === 'cur')?.blank).toBe(true)
  })
})

describe('status grouping', () => {
  it('places every visible session in exactly one section and omits empty sections', () => {
    const sections = statusSections(buildRows(inputs()), 'default')
    expect(sections.map(section => section.key)).toEqual(['pinned', 'active', 'working', 'snoozed'])
    const byKey = Object.fromEntries(sections.map(section => [section.key, ids(section.rows)]))
    expect(byKey).toEqual({ pinned: ['d'], active: ['cur', 'a'], working: ['b'], snoozed: ['c'] })
    const all = sections.flatMap(section => ids(section.rows))
    expect(new Set(all).size).toBe(all.length)
  })

  it('adds an Archived section when archived sessions are shown, and only it when only archived are', () => {
    const base = inputs()
    const rows = buildRows({ ...base, workspaces: { ...base.workspaces, archivedSessionIds: ['a'] } })
    expect(statusSections(rows, 'default').flatMap(section => ids(section.rows))).not.toContain('a')
    expect(statusSections(rows, 'show').at(-1)).toMatchObject({ key: 'archived', rows: [expect.objectContaining({ sessionId: 'a' })] })
    expect(statusSections(rows, 'only').map(section => section.key)).toEqual(['archived'])
    expect(statusSections(buildRows(inputs()), 'only')).toEqual([])
  })
})

describe('workspace grouping', () => {
  it('lists workspaces in Host order, keeps empty ones, and ends with Ungrouped', () => {
    const groups = workspaceGroups(buildRows(inputs()), inputs().workspaces, 'default', 'Ungrouped')
    expect(groups.map(group => [group.key, group.title])).toEqual([['w1', 'One'], ['w2', 'Two'], ['', 'Ungrouped']])
    expect(groups[1]!.rows).toHaveLength(0)
  })

  it('orders pinned first, then by last update, with parked sessions in place', () => {
    const groups = workspaceGroups(buildRows(inputs()), inputs().workspaces, 'default', 'Ungrouped')
    expect(ids(groups[0]!.rows)).toEqual(['b', 'a'])
    // d is pinned (oldest), c is snoozed and stays in its place by recency.
    expect(ids(groups[2]!.rows)).toEqual(['d', 'cur', 'c'])
    expect(groups[2]!.containsCurrent).toBe(true)
  })

  it('drops groups without archived rows in the archived-only view', () => {
    const base = inputs()
    const rows = buildRows({ ...base, workspaces: { ...base.workspaces, archivedSessionIds: ['a'] } })
    const groups = workspaceGroups(rows, base.workspaces, 'only', 'Ungrouped')
    expect(groups.map(group => group.key)).toEqual(['w1'])
    expect(ids(groups[0]!.rows)).toEqual(['a'])
  })
})

describe('one list', () => {
  it('leads with pinned sessions and follows the archived filter', () => {
    expect(ids(flatRows(buildRows(inputs()), 'default'))).toEqual(['d', 'cur', 'b', 'c', 'a'])
    const base = inputs()
    const rows = buildRows({ ...base, workspaces: { ...base.workspaces, archivedSessionIds: ['d'] } })
    expect(ids(flatRows(rows, 'default'))).not.toContain('d')
    expect(ids(flatRows(rows, 'show'))).toContain('d')
  })
})

describe('watermark', () => {
  const make = (count: number, attentionAt: number[] = []): Row[] => {
    const base = buildRows(inputs())[0]!
    return Array.from({ length: count }, (_, index) => ({
      ...base, sessionId: `s${index}`, current: false, blank: false, status: attentionAt.includes(index) ? 'running' as const : 'idle' as const,
    }))
  }

  it('shows five rows and counts the rest', () => {
    const shown = watermarkRows(make(8), WATERMARK_BASE)
    expect(shown.rows).toHaveLength(5)
    expect(shown.hiddenCount).toBe(3)
  })

  it('raises the watermark to cover attention rows', () => {
    expect(requiredWatermark(make(8))).toBe(WATERMARK_BASE)
    expect(requiredWatermark(make(12, [9]))).toBe(10)
  })
})

describe('search', () => {
  it('matches titles locally, then appends content hits once each with their snippets', () => {
    const rows = buildRows(inputs())
    const results = searchResults(rows, 'title b', [{ sessionId: 'd', snippet: '…zebra…' }, { sessionId: 'b' }], 'default', 50)
    expect(results.map(result => [result.row.sessionId, result.snippet])).toEqual([['b', null], ['d', '…zebra…']])
  })

  it('never matches blank sessions and honours the limit and archived filter', () => {
    const base = inputs()
    const rows = buildRows({ ...base, workspaces: { ...base.workspaces, archivedSessionIds: ['a'] } })
    expect(searchResults(rows, 'title', [], 'default', 50).map(result => result.row.sessionId)).not.toContain('a')
    expect(searchResults(rows, 'title', [], 'default', 2)).toHaveLength(2)
    expect(searchResults(rows, 'cur', [], 'show', 50)).toEqual([])
  })

  it('keeps queries within the session.search contract', () => {
    expect(sanitizeQuery('a\0b')).toBe('ab')
    expect(sanitizeQuery('x'.repeat(600))).toHaveLength(500)
    expect(sanitizeQuery(`${'x'.repeat(499)}😀`)).toHaveLength(499)
  })
})

describe('quick action (replaces the native Archive button)', () => {
  const rowOf = (id: string, patch: Partial<ModelInputs> = {}) => buildRows(inputs(patch)).find(row => row.sessionId === id)!
  const idleView = (id: string, extra: Partial<TaskView['record']> = {}): TaskView => ({
    sessionId: id, record: { ...emptyRecord(id, 0), ...extra }, activity: [], autoSettleDeadline: null, autoSettleSkip: null,
  })

  it('offers Settle for a known-idle session and Unsettle for a settled one', () => {
    expect(quickActionOf(rowOf('c', { tasks: new Map([['c', idleView('c')]]) }))).toBe('settle')
    const settled = idleView('c', { disposition: { kind: 'settled', reason: 'manual', enteredAt: NOW, baselinePending: [], baselineTurnStartSeq: null, baselineUserInputAt: null } })
    expect(quickActionOf(rowOf('c', { tasks: new Map([['c', settled]]) }))).toBe('unsettle')
  })

  it('hides Settle while running, awaiting the user, pinned, unsynchronized or blank, and offers Unarchive when archived', () => {
    expect(quickActionOf(rowOf('b', { tasks: new Map([['b', idleView('b')]]) }))).toBeNull()
    expect(quickActionOf(rowOf('a', { tasks: new Map([['a', idleView('a')]]) }))).toBeNull()
    expect(quickActionOf(rowOf('d', { tasks: new Map([['d', idleView('d')]]) }))).toBeNull()
    expect(quickActionOf(rowOf('c', { tasks: new Map() }))).toBeNull()
    expect(quickActionOf(rowOf('cur'))).toBeNull()
    const base = inputs()
    expect(quickActionOf(rowOf('c', { workspaces: { ...base.workspaces, archivedSessionIds: ['c'] } }))).toBe('unarchive')
  })

  it('agrees with the settle rule on live facts', () => {
    const row = rowOf('c', { tasks: new Map([['c', idleView('c')]]) })
    expect(row.facts.activity).toEqual(known([]))
    expect(row.facts.summary).toEqual(EMPTY_ACTIVITY)
  })
})

describe('preferences', () => {
  it('defaults to the status grouping with archived sessions hidden', () => {
    expect(migratePrefs(undefined)).toEqual(DEFAULT_PREFS)
    expect(DEFAULT_PREFS).toMatchObject({ groupBy: 'status', archivedFilter: 'default' })
  })

  it('migrates the R0 alpha shape', () => {
    const migrated = migratePrefs({
      view: 'projects', scope: 'w1', includeContent: true,
      collapsed: { 'tasks:settled': false, 'projects:p:w1': true, 'status:active': true }, lastSeen: { a: 3, b: 'x' },
    })
    expect(migrated).toEqual({
      groupBy: 'workspace', archivedFilter: 'default',
      collapsed: { 'status:settled': false, 'status:active': true }, lastSeen: { a: 3 },
    })
    expect(migratePrefs({ view: 'tasks' }).groupBy).toBe('status')
  })

  it('keeps current values and rejects unknown ones', () => {
    expect(migratePrefs({ groupBy: 'flat', archivedFilter: 'only' })).toMatchObject({ groupBy: 'flat', archivedFilter: 'only' })
    expect(migratePrefs({ groupBy: 'tree', archivedFilter: 'all' })).toMatchObject({ groupBy: 'status', archivedFilter: 'default' })
  })
})
