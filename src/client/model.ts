/**
 * Pure view model: joins native Harness snapshots (sessions, workspaces,
 * session status) with plugin task records into rows, sections and project
 * groups. Both views read the same rows, so a session is placed identically.
 */
import { derivePlacement, rowStatus, type RowStatus } from '../domain/placement.ts'
import { comparatorFor, type SortInput } from '../domain/sort.ts'
import {
  EMPTY_ACTIVITY, PLACEMENTS, known, unknown,
  type NativeState, type PendingSignal, type Placement, type TaskFacts, type TaskRecord,
} from '../domain/types.ts'
import type { TaskView } from '../contracts/schema.ts'

/** Structural view of `SessionSummary` (api-session-controller 0.2.2-rc.1). */
export interface SessionRow {
  readonly id: string
  readonly displayTitle: string
  readonly title?: string
  readonly cwd?: string
  readonly parentId?: string
  readonly origin?: 'subagent'
  readonly running: boolean
  readonly blank: boolean
  readonly updatedAt: number
  readonly retainedBy?: { readonly mainView?: number }
  readonly projectionValues?: { readonly userQuestions?: { readonly active?: readonly { readonly callId: string; readonly state: string }[] } }
}

export interface SessionsSnapshot {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionRow>>
  readonly phase: string
}

export interface WorkspaceRow {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

export interface WorkspacesSnapshot {
  readonly items: readonly WorkspaceRow[]
  readonly pinnedSessionIds: readonly string[]
  readonly archivedSessionIds: readonly string[]
  readonly phase: string
}

export interface SessionStatusEntry {
  readonly running: boolean | undefined
  readonly pendingInteraction?: { readonly key: string; readonly kind: string } | undefined
  readonly completionUnread: boolean
}

export type StatusSnapshot = ReadonlyMap<string, SessionStatusEntry>

export interface Row {
  readonly sessionId: string
  readonly title: string
  readonly untitled: boolean
  readonly workspaceId: string | null
  readonly workspaceTitle: string | null
  readonly placement: Placement | null
  readonly status: RowStatus
  readonly current: boolean
  readonly native: NativeState
  readonly facts: TaskFacts
  readonly record: TaskRecord | undefined
  readonly view: TaskView | undefined
  readonly pendingSignals: readonly PendingSignal[]
  readonly sort: SortInput
}

export interface ModelInputs {
  readonly sessions: SessionsSnapshot
  readonly workspaces: WorkspacesSnapshot
  readonly status: StatusSnapshot
  readonly tasks: ReadonlyMap<string, TaskView>
  readonly lastSeen: Readonly<Record<string, number>>
  readonly now: number
}

/** Pending interactions this browser can see (live winner + durable asks). */
export function pendingOf(session: SessionRow, status: SessionStatusEntry | undefined): PendingSignal[] {
  const signals: PendingSignal[] = []
  const live = status?.pendingInteraction
  if (live !== undefined) signals.push({ source: 'live', key: live.key, kind: live.kind })
  for (const ask of session.projectionValues?.userQuestions?.active ?? []) {
    if (live?.key === ask.callId) continue
    signals.push({ source: 'userQuestions', key: ask.callId, kind: 'user-question' })
  }
  return signals
}

export function buildRows(inputs: ModelInputs): Row[] {
  const { sessions, workspaces, status, tasks, lastSeen, now } = inputs
  const pinned = new Map(workspaces.pinnedSessionIds.map((id, index) => [id, index]))
  const archived = new Set(workspaces.archivedSessionIds)
  const owner = new Map<string, WorkspaceRow>()
  for (const workspace of workspaces.items) {
    for (const id of workspace.sessionIds) if (!owner.has(id)) owner.set(id, workspace)
  }
  const rows: Row[] = []
  for (const id of sessions.ids) {
    const session = sessions.byId[id]
    if (session === undefined || session.origin === 'subagent') continue
    const current = (session.retainedBy?.mainView ?? 0) > 0
    if (session.blank && !current) continue
    const entry = status.get(id)
    const view = tasks.get(id)
    const record = view?.record
    const pendingSignals = pendingOf(session, entry)
    const running = entry?.running ?? session.running
    const facts: TaskFacts = {
      running: known(running),
      pending: known(pendingSignals),
      // The browser's live `running` is authoritative for the session's own turn;
      // the Host adds the families only it can see (subagents, jobs, schedules).
      activity: view?.activity === null || view?.activity === undefined
        ? unknown
        : known(view.activity.filter(kind => kind !== 'turn').concat(running ? ['turn'] : [])),
      summary: record?.activity ?? EMPTY_ACTIVITY,
    }
    const native: NativeState = { pinned: pinned.has(id), archived: archived.has(id) }
    const workspace = owner.get(id)
    const untitled = (session.title ?? '').trim() === '' && session.displayTitle === id
    rows.push({
      sessionId: id,
      title: session.displayTitle,
      untitled,
      workspaceId: workspace?.workspaceId ?? null,
      workspaceTitle: workspace?.title ?? null,
      placement: derivePlacement(facts, record, native, now),
      status: completionAware(rowStatus(facts, lastSeen[id] ?? null), entry, record),
      current,
      native,
      facts,
      record,
      view,
      pendingSignals,
      sort: { sessionId: id, facts, record, pinIndex: pinned.get(id) ?? -1, fallbackAt: session.updatedAt },
    })
  }
  return rows
}

/**
 * Without a Host summary the browser's own completion reminder is the only
 * "new result" signal; use it rather than claiming the task is idle.
 */
function completionAware(status: RowStatus, entry: SessionStatusEntry | undefined, record: TaskRecord | undefined): RowStatus {
  if (status === 'idle' && record === undefined && entry?.completionUnread === true) return 'new-result'
  return status
}

export interface Filter {
  /** Workspace id, `ungrouped`, or null for all projects. */
  readonly scope: string | null
  readonly query: string
  /** Extra ids matched by content search (request-local). */
  readonly contentHits: ReadonlySet<string> | null
}

export function matches(row: Row, filter: Filter): boolean {
  if (filter.scope === 'ungrouped' ? row.workspaceId !== null : filter.scope !== null && row.workspaceId !== filter.scope) {
    return false
  }
  const query = filter.query.trim().toLowerCase()
  if (query === '') return true
  if (row.title.toLowerCase().includes(query)) return true
  if ((row.workspaceTitle ?? '').toLowerCase().includes(query)) return true
  return filter.contentHits?.has(row.sessionId) ?? false
}

export interface Section {
  readonly placement: Placement
  readonly rows: readonly Row[]
}

/** Five task sections, each sorted by its own rule. */
export function taskSections(rows: readonly Row[], filter: Filter): Section[] {
  const buckets = new Map<Placement, Row[]>(PLACEMENTS.map(placement => [placement, []]))
  for (const row of rows) {
    if (row.placement === null || !matches(row, filter)) continue
    buckets.get(row.placement)!.push(row)
  }
  return PLACEMENTS.map((placement) => {
    const compare = comparatorFor(placement)
    const sorted = [...buckets.get(placement)!].sort((left, right) => compare(left.sort, right.sort))
    return { placement, rows: sorted }
  })
}

export function archivedRows(rows: readonly Row[], filter: Filter): Row[] {
  return rows.filter(row => row.native.archived && matches(row, filter))
}

export interface ProjectGroup {
  readonly workspaceId: string | null
  readonly title: string
  readonly path: string | null
  /** Pinned, attention, working, then other active rows. */
  readonly primary: readonly Row[]
  /** Snoozed and settled rows, shown in a collapsed sub-group. */
  readonly later: readonly Row[]
}

/** Statuses that count as an attention event (approval, question, failure, new result). */
const ATTENTION: ReadonlySet<RowStatus> = new Set<RowStatus>(['approval', 'input', 'attention', 'failed', 'new-result', 'needs-check'])

/** Project-view rank: pinned → Active needing attention → Working → other Active → Snoozed → Settled. */
export function projectRank(row: Pick<Row, 'placement' | 'status'>): number {
  switch (row.placement) {
    case 'pinned': return 0
    case 'active': return ATTENTION.has(row.status) ? 1 : 3
    case 'working': return 2
    case 'snoozed': return 4
    default: return 5
  }
}

/** Workspace groups in Host order, plus an Ungrouped group. */
export function projectGroups(rows: readonly Row[], workspaces: WorkspacesSnapshot, filter: Filter, ungroupedTitle: string): ProjectGroup[] {
  const byWorkspace = new Map<string | null, Row[]>()
  for (const row of rows) {
    if (row.placement === null || !matches(row, filter)) continue
    const key = row.workspaceId
    if (!byWorkspace.has(key)) byWorkspace.set(key, [])
    byWorkspace.get(key)!.push(row)
  }
  const order = (left: Row, right: Row): number =>
    (projectRank(left) - projectRank(right)) || comparatorFor(left.placement!)(left.sort, right.sort)
  const group = (workspaceId: string | null, title: string, path: string | null): ProjectGroup => {
    const all = [...(byWorkspace.get(workspaceId) ?? [])].sort(order)
    return {
      workspaceId,
      title,
      path,
      primary: all.filter(row => row.placement !== 'snoozed' && row.placement !== 'settled'),
      later: all.filter(row => row.placement === 'snoozed' || row.placement === 'settled'),
    }
  }
  const groups: ProjectGroup[] = []
  for (const workspace of workspaces.items) {
    if (filter.scope !== null && filter.scope !== workspace.workspaceId) continue
    const g = group(workspace.workspaceId, workspace.title, workspace.path)
    // Empty projects stay visible (they can start a session) unless a search is active.
    if (filter.query.trim() !== '' && g.primary.length + g.later.length === 0) continue
    groups.push(g)
  }
  if (filter.scope === null || filter.scope === 'ungrouped') {
    const ungrouped = group(null, ungroupedTitle, null)
    if (ungrouped.primary.length + ungrouped.later.length > 0) groups.push(ungrouped)
  }
  return groups
}
