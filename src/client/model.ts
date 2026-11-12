/**
 * Pure view model: joins native Harness snapshots (sessions, workspaces,
 * session status) with plugin task records into rows, then arranges them for
 * the three groupings (status sections, workspaces, one list), search results
 * and the native "show more" watermark. Every grouping reads the same rows, so
 * a session is placed identically everywhere.
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
  /** Workspace creation time (epoch ms), shown on the group hover card. */
  readonly createdAt?: number
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
  /** Host display title (falls back to the session id when the session has no title). */
  readonly title: string
  /** The session's own stored title, or empty: what rename and copy act on. */
  readonly storedTitle: string
  readonly untitled: boolean
  /** The provisional blank session (shown as "New session"). */
  readonly blank: boolean
  /** List activity time (native "last updated"). */
  readonly updatedAt: number
  /** Session working directory, when the Host reports one. */
  readonly cwd: string | null
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
      storedTitle: (session.title ?? '').trim(),
      untitled,
      blank: session.blank,
      updatedAt: session.updatedAt,
      cwd: session.cwd === undefined || session.cwd === '' ? null : session.cwd,
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

/** Session-list grouping: semantic status sections (default), workspaces, or one list. */
export type GroupBy = 'status' | 'workspace' | 'flat'
/** Archived-row visibility, as the native view options name it. */
export type ArchivedFilter = 'default' | 'show' | 'only'

/** Whether one row is visible under the archived filter. */
export function visibleUnder(row: Pick<Row, 'native'>, filter: ArchivedFilter): boolean {
  if (filter === 'only') return row.native.archived
  return filter === 'show' || !row.native.archived
}

/** Status-grouping section keys: the five placements plus the archived bucket. */
export type SectionKey = Placement | 'archived'

export interface Section {
  readonly key: SectionKey
  readonly rows: readonly Row[]
}

const byRecency = (left: Row, right: Row): number =>
  (right.updatedAt - left.updatedAt) || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0)

/**
 * Status sections in display order, each sorted by its own rule. Empty
 * sections are omitted: the sidebar shows only sections that hold a row.
 */
export function statusSections(rows: readonly Row[], filter: ArchivedFilter): Section[] {
  const buckets = new Map<SectionKey, Row[]>([...PLACEMENTS, 'archived' as const].map(key => [key, []]))
  for (const row of rows) {
    if (!visibleUnder(row, filter)) continue
    const key: SectionKey | null = row.native.archived ? 'archived' : row.placement
    if (key !== null) buckets.get(key)!.push(row)
  }
  const sections: Section[] = []
  for (const placement of PLACEMENTS) {
    const compare = comparatorFor(placement)
    // The current blank "New session" row leads its section, as in the native list.
    const sorted = [...buckets.get(placement)!].sort((left, right) =>
      (left.blank !== right.blank ? (left.blank ? -1 : 1) : 0) || compare(left.sort, right.sort))
    if (sorted.length > 0) sections.push({ key: placement, rows: sorted })
  }
  const archived = [...buckets.get('archived')!].sort(byRecency)
  if (archived.length > 0) sections.push({ key: 'archived', rows: archived })
  return sections
}

/**
 * Native list order: pinned rows lead in pin order, then the current blank
 * "New session" row, then the rest by last update.
 */
export function listOrder(left: Row, right: Row): number {
  const leftPinned = left.native.pinned && !left.native.archived
  const rightPinned = right.native.pinned && !right.native.archived
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
  if (leftPinned) return (left.sort.pinIndex - right.sort.pinIndex) || byRecency(left, right)
  if (left.blank !== right.blank) return left.blank ? -1 : 1
  return byRecency(left, right)
}

export interface WorkspaceGroup {
  /** Group key: the workspace id, or {@link UNGROUPED} for sessions outside every workspace. */
  readonly key: string
  readonly workspaceId: string | null
  readonly title: string
  readonly path: string | null
  readonly createdAt: number | null
  readonly rows: readonly Row[]
  readonly containsCurrent: boolean
}

/** Group key of the bucket for sessions outside every workspace. */
export const UNGROUPED = ''

/**
 * Workspace groups in Host order plus a trailing Ungrouped group. Empty
 * workspaces stay (they can start a session) except in the archived-only
 * view, which lists only groups that hold an archived row; Ungrouped shows
 * only when it holds a row.
 */
export function workspaceGroups(
  rows: readonly Row[], workspaces: WorkspacesSnapshot, filter: ArchivedFilter, ungroupedTitle: string,
): WorkspaceGroup[] {
  const byWorkspace = new Map<string, Row[]>()
  for (const row of rows) {
    if (!visibleUnder(row, filter)) continue
    const key = row.workspaceId ?? UNGROUPED
    if (!byWorkspace.has(key)) byWorkspace.set(key, [])
    byWorkspace.get(key)!.push(row)
  }
  const group = (key: string, workspace: WorkspaceRow | null): WorkspaceGroup => {
    const members = [...(byWorkspace.get(key) ?? [])].sort(listOrder)
    return {
      key,
      workspaceId: workspace?.workspaceId ?? null,
      title: workspace?.title ?? ungroupedTitle,
      path: workspace?.path ?? null,
      createdAt: workspace?.createdAt ?? null,
      rows: members,
      containsCurrent: members.some(row => row.current),
    }
  }
  const groups = workspaces.items.map(workspace => group(workspace.workspaceId, workspace))
    .filter(candidate => filter !== 'only' || candidate.rows.length > 0)
  const ungrouped = group(UNGROUPED, null)
  if (ungrouped.rows.length > 0) groups.push(ungrouped)
  return groups
}

/** Every visible session in one list, in native list order. */
export function flatRows(rows: readonly Row[], filter: ArchivedFilter): Row[] {
  return rows.filter(row => visibleUnder(row, filter)).sort(listOrder)
}

/** Statuses that count as an attention event (approval, question, failure, new result). */
const ATTENTION: ReadonlySet<RowStatus> = new Set<RowStatus>(['approval', 'input', 'attention', 'failed', 'new-result', 'needs-check'])

/** Rows a collapsed list must keep in view: live work, an ask, a new result, or the current session. */
export function wantsAttention(row: Pick<Row, 'status' | 'current'>): boolean {
  return row.current || row.status === 'running' || ATTENTION.has(row.status)
}

/** Non-blank rows a group shows before "Show more" (native watermark). */
export const WATERMARK_BASE = 5
/** Highest watermark attention rows raise automatically. */
export const WATERMARK_AUTO_MAX = 50

/** The blank row plus the first `watermark` non-blank rows, in list order. */
export function watermarkRows(rows: readonly Row[], watermark: number): { rows: readonly Row[]; hiddenCount: number } {
  let count = 0
  const shown = rows.filter((row) => {
    if (row.blank) return true
    count += 1
    return count <= watermark
  })
  return { rows: shown, hiddenCount: rows.length - shown.length }
}

/** Smallest watermark (at least the base) covering every attention row within the automatic maximum. */
export function requiredWatermark(rows: readonly Row[]): number {
  let index = 0
  let required = WATERMARK_BASE
  for (const row of rows) {
    if (row.blank) continue
    index += 1
    if (index <= WATERMARK_AUTO_MAX && wantsAttention(row)) required = Math.max(required, index)
  }
  return required
}

/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
export const SEARCH_QUERY_MAX = 500

/** Keep a query inside the `session.search` contract: no NUL, at most 500 code units, no split surrogate pair. */
export function sanitizeQuery(value: string): string {
  const withoutNul = value.replaceAll('\0', '')
  if (withoutNul.length <= SEARCH_QUERY_MAX) return withoutNul
  let end = SEARCH_QUERY_MAX
  const last = withoutNul.charCodeAt(end - 1)
  const next = withoutNul.charCodeAt(end)
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--
  return withoutNul.slice(0, end)
}

export interface ContentHit {
  readonly sessionId: string
  readonly snippet?: string | undefined
}

export interface SearchResult {
  readonly row: Row
  readonly snippet: string | null
}

export interface SearchResultSet {
  readonly items: readonly SearchResult[]
  /** More sessions matched than `limit` allows (local and content matches combined). */
  readonly truncated: boolean
}

/**
 * Search results: local title / workspace / id matches by recency, then the
 * Host's content matches in their order, each session once, capped at `limit`.
 * Blank sessions never match; results follow the archived filter.
 */
export function searchResults(
  rows: readonly Row[], query: string, content: readonly ContentHit[], filter: ArchivedFilter, limit: number,
): SearchResultSet {
  const q = query.trim().toLowerCase()
  if (q === '') return { items: [], truncated: false }
  const eligible = rows.filter(row => !row.blank && visibleUnder(row, filter))
  const byId = new Map(eligible.map(row => [row.sessionId, row]))
  const snippets = new Map<string, string>()
  for (const hit of content) if (hit.snippet !== undefined && !snippets.has(hit.sessionId)) snippets.set(hit.sessionId, hit.snippet)
  const ordered: Row[] = []
  const seen = new Set<string>()
  const include = (row: Row | undefined) => {
    if (row === undefined || seen.has(row.sessionId)) return
    seen.add(row.sessionId)
    ordered.push(row)
  }
  const local = eligible.filter(row => row.title.toLowerCase().includes(q)
    || (row.workspaceTitle ?? '').toLowerCase().includes(q)
    || row.sessionId.toLowerCase().includes(q)).sort(byRecency)
  for (const row of local) include(row)
  for (const hit of content) include(byId.get(hit.sessionId))
  return {
    items: ordered.slice(0, limit).map(row => ({ row, snippet: snippets.get(row.sessionId) ?? null })),
    truncated: ordered.length > limit,
  }
}

/** Keys that move focus between list rows (the arrow keys and Home / End). */
export type ListKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

/** Index of the row a list-navigation key moves focus to, or null for any other key. */
export function nextFocusIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowDown': return Math.min(count - 1, index + 1)
    case 'ArrowUp': return Math.max(0, index - 1)
    case 'Home': return 0
    case 'End': return count - 1
    default: return null
  }
}
