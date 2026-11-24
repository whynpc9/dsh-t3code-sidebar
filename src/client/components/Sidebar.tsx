/**
 * The `sidebar.workspaces` occupant, composed like the native workspace
 * browser it replaces: a section header (title, expanding search, view
 * options, add workspace), then the session list grouped by task status
 * (default), by workspace, or as one list; search swaps the list for flat
 * results. The rail (collapsed sidebar) keeps search and add workspace as
 * 36px controls. Settings live on this plugin's page under Plugins.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import {
  AnimatedRows, HoverCardGroup, IconAlarmClockOutlineRegular, IconArchiveCheckOutlineRegular, IconArchiveOffOutlineRegular,
  IconArchiveOutlineRegular, IconCheckCircleOutlineRegular, IconChecklistOutlineRegular, IconCloseFillRegular,
  IconFlatListOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular, IconPinOutlineRegular, IconPlayOutlineRegular,
  IconProjectAddOutlineRegular, IconQueueOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular,
  IconSlidersTwoOutlineRegular, Menu, StateDot, Toast, Tooltip, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Key } from '../locales.ts'
import {
  buildRows, hostActivityKnown, flatRows, nextFocusIndex, requiredWatermark, sanitizeQuery, searchResults, statusSections, visibleUnder, watermarkRows, workspaceGroups,
  WATERMARK_BASE, type ArchivedFilter, type ContentHit, type GroupBy, type Row, type SectionKey,
} from '../model.ts'
import type { Readable } from '../store.ts'
import type { Prefs, Runtime, SearchPage } from '../runtime.ts'
import { FlatSessionList } from './FlatSessionList.tsx'
import { AddWorkspaceDialog, RemoveWorkspaceDialog, RenameWorkspaceDialog, ResumeDialog, SnoozeDialog } from './Dialogs.tsx'
import {
  cx, GroupRow, GroupSessionRows, SearchResultRow, workspaceMenuIcons, WorkspaceHoverContent,
  type ContextMenuBindings, type RowEnv,
} from './Rows.tsx'

const use = <T,>(source: Readable<T>): T => useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)

/** Column slide length: rail search waits it out before focusing. */
const EXPAND_SLIDE_MS = 300
const SEARCH_DEBOUNCE_MS = 250
/** While the Host is still indexing history, search again this often. */
const INDEXING_POLL_MS = 1500

const SECTION_ICON: Record<SectionKey, ReactNode> = {
  pinned: <IconPinOutlineRegular />,
  active: <IconQueueOutlineRegular />,
  working: <IconPlayOutlineRegular />,
  snoozed: <IconAlarmClockOutlineRegular />,
  settled: <IconCheckCircleOutlineRegular />,
  archived: <IconArchiveOutlineRegular />,
}

/** Sections collapsed until the user opens them. */
const COLLAPSED_BY_DEFAULT: ReadonlySet<SectionKey> = new Set<SectionKey>(['snoozed', 'settled'])
/** Sections that always list every row (no "Show more"). */
const UNCAPPED: ReadonlySet<SectionKey> = new Set<SectionKey>(['pinned', 'working'])

export interface SidebarProps {
  readonly runtime: Runtime
  readonly wide?: boolean
  readonly expandSidebar?: () => void
  readonly useContextMenu?: () => ContextMenuBindings
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()) }, intervalMs)
    return () => { clearInterval(id) }
  }, [intervalMs])
  return now
}

interface RemoteSearch {
  readonly query: string
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly items: readonly ContentHit[]
  readonly hasMore: boolean
  readonly indexing?: SearchPage['indexing']
}

type WorkspaceDialog = { readonly kind: 'add' } | { readonly kind: 'rename' | 'remove'; readonly workspaceId: string; readonly title: string }

function ViewOptionsMenu({ groupBy, archivedFilter, onGroupBy, onArchivedFilter, openSettings, t }: {
  groupBy: GroupBy
  archivedFilter: ArchivedFilter
  onGroupBy: (mode: GroupBy) => void
  onArchivedFilter: (filter: ArchivedFilter) => void
  openSettings: (() => void) | undefined
  t: Runtime['t']
}) {
  const [open, setOpen] = useState(false)
  const items: MenuEntry[] = [
    { type: 'label', id: 'group-by', text: t('groupBy.label') },
    { id: 'status', label: t('groupBy.status'), icon: <IconChecklistOutlineRegular /> },
    { id: 'workspace', label: t('groupBy.workspace'), icon: <IconFolderCloseRegular /> },
    { id: 'flat', label: t('groupBy.flat'), icon: <IconFlatListOutlineRegular /> },
    { type: 'separator', id: 'filter-separator' },
    { type: 'label', id: 'filter-by', text: t('filterBy.label') },
    { id: 'hide-archived', label: t('viewOptions.hideArchived'), icon: <IconArchiveOffOutlineRegular /> },
    { id: 'show-archived', label: t('viewOptions.showArchived'), icon: <IconQueueOutlineRegular /> },
    { id: 'only-archived', label: t('viewOptions.onlyArchived'), icon: <IconArchiveCheckOutlineRegular /> },
  ]
  if (openSettings !== undefined) {
    items.push({ type: 'separator', id: 'settings-separator' }, { id: 'settings', label: t('viewOptions.settings'), icon: <IconSettingsOutlineRegular /> })
  }
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={items}
      selectedIds={[groupBy, { default: 'hide-archived', show: 'show-archived', only: 'only-archived' }[archivedFilter]]}
      onSelect={(id) => {
        if (id === 'status' || id === 'workspace' || id === 'flat') onGroupBy(id)
        else if (id === 'hide-archived') onArchivedFilter('default')
        else if (id === 'show-archived') onArchivedFilter('show')
        else if (id === 'only-archived') onArchivedFilter('only')
        else if (id === 'settings') openSettings?.()
        setOpen(false)
      }}
      align="end"
      dense
      listClassName="t3sb-view-options-menu"
      portal
      anchor={(
        <Tooltip label={t('viewOptions.label')} side="bottom" delayMs={500} portal>
          <button type="button" className="t3sb-header-button t3sb-wide" aria-label={t('viewOptions.label')} data-testid="t3-view-options"
            aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
            <IconSlidersTwoOutlineRegular />
          </button>
        </Tooltip>
      )}
    />
  )
}

function EmptySessions({ archivedOnly, onLeaveArchivedOnly, t }: { archivedOnly: boolean; onLeaveArchivedOnly: () => void; t: Runtime['t'] }) {
  return (
    <div className="t3sb-empty-state" data-row-key="empty">
      {archivedOnly ? <IconArchiveOutlineRegular size={24} /> : <IconQueueOutlineRegular size={24} />}
      <div>{archivedOnly ? t('empty.noneArchived') : t('empty.none')}</div>
      {archivedOnly && <button type="button" className="t3sb-empty-action" onClick={onLeaveArchivedOnly}>{t('empty.viewOthers')}</button>}
    </div>
  )
}

export function TaskSidebar({ runtime, wide = true, expandSidebar, useContextMenu }: SidebarProps) {
  const menu = useContextMenu?.()
  const locale = use(runtime.locale)
  const t = runtime.t
  const sessions = use(runtime.sessions)
  const workspaces = use(runtime.workspaces)
  const status = use(runtime.status)
  const backend = use(runtime.backend)
  const prefs = use(runtime.prefs)
  const snoozeTarget = use(runtime.snoozeRequest)
  const resumeTarget = use(runtime.resumeRequest)
  const notice = use(runtime.notice)
  const now = useNow(30_000) + backend.clockOffset
  const { groupBy, archivedFilter } = prefs

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    runtime.prefs.set({ ...runtime.prefs.getSnapshot(), ...patch })
  }, [runtime])

  const rows = useMemo(
    () => wide ? buildRows({ sessions, workspaces, status, tasks: backend.tasks, lastSeen: prefs.lastSeen, now, hostActivity: hostActivityKnown(backend) }) : [],
    [wide, sessions, workspaces, status, backend.tasks, prefs.lastSeen, now, backend.kind, backend.status, backend.capabilities.hostActivity],
  )
  const current = useMemo(() => rows.find(row => row.current), [rows])
  // The rail still tracks read markers and the current workspace without building the list.
  const currentId = useMemo(() => wide ? current?.sessionId : sessions.ids.find(id => {
    const session = sessions.byId[id]
    return session?.origin !== 'subagent' && (session?.retainedBy?.mainView ?? 0) > 0
  }), [wide, current, sessions])
  const lastTurnSeq = currentId === undefined ? undefined : backend.tasks.get(currentId)?.record.activity.lastTurnEnd?.seq

  // Retry unread results on the sidebar clock when the window regains focus.
  useEffect(() => {
    if (currentId === undefined || lastTurnSeq === undefined || !document.hasFocus()) return
    if ((prefs.lastSeen[currentId] ?? -1) >= lastTurnSeq) return
    setPrefs({ lastSeen: { ...prefs.lastSeen, [currentId]: lastTurnSeq } })
  }, [current, currentId, lastTurnSeq, now, prefs.lastSeen, setPrefs])

  // ── Search (native composition: the icon expands into the input) ──
  const [query, setQuery] = useState('')
  const [locateTarget, setLocateTarget] = useState<string | null>(null)
  const listArea = useRef<HTMLDivElement | null>(null)
  const searchButton = useRef<HTMLButtonElement | null>(null)
  const [snoozeFocusTarget, setSnoozeFocusTarget] = useState<string | null>(null)
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [searchMotion, setSearchMotion] = useState(false)
  const [searchOnExpand, setSearchOnExpand] = useState(false)
  const [remote, setRemote] = useState<RemoteSearch>({ query: '', status: 'idle', items: [], hasMore: false })
  const searchRoot = useRef<HTMLDivElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  const normalizedQuery = sanitizeQuery(query).trim()
  const focusSearch = useCallback(() => { searchInput.current?.focus({ preventScroll: true }) }, [])
  const changeSearchExpanded = (expanded: boolean) => {
    setSearchMotion(wide)
    setSearchExpanded(expanded)
  }
  useEffect(() => {
    if (!wide || !searchOnExpand) return
    const timer = window.setTimeout(() => { setSearchExpanded(true); focusSearch(); setSearchOnExpand(false) }, EXPAND_SLIDE_MS)
    return () => { window.clearTimeout(timer) }
  }, [wide, searchOnExpand, focusSearch])
  useEffect(() => {
    if (!wide || !searchExpanded || searchOnExpand) return
    focusSearch()
  }, [wide, searchExpanded, searchOnExpand, focusSearch])
  useEffect(() => {
    if (!wide || !searchExpanded || searchOnExpand) return
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || searchRoot.current?.contains(event.target) === true) return
      searchInput.current?.blur()
      if (normalizedQuery !== '') return
      changeSearchExpanded(false)
    }
    document.addEventListener('click', onClick)
    return () => { document.removeEventListener('click', onClick) }
  })
  const historySearch = prefs.historySearch
  useEffect(() => {
    if (normalizedQuery === '') { setRemote({ query: '', status: 'idle', items: [], hasMore: false }); return }
    const controller = new AbortController()
    setRemote({ query: normalizedQuery, status: 'loading', items: [], hasMore: false })
    const run = () => {
      runtime.search(normalizedQuery, controller.signal).then((page) => {
        if (controller.signal.aborted) return
        setRemote({ query: normalizedQuery, status: 'ready', items: page.items, hasMore: page.hasMore, indexing: page.indexing })
        // Ask again only while the Host is still listing or reading sessions.
        if (page.indexing?.reading === true) timer = window.setTimeout(run, INDEXING_POLL_MS)
      }, () => {
        if (!controller.signal.aborted) setRemote({ query: normalizedQuery, status: 'error', items: [], hasMore: false })
      })
    }
    let timer = window.setTimeout(run, SEARCH_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [normalizedQuery, runtime, historySearch])
  const clearSearch = () => { setQuery(''); changeSearchExpanded(false) }

  // ── Dialogs ──
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialog | null>(null)

  // ── Native ⌘K / ⌘O: the native workspace commands only raise requests for the
  //    browser that owns this slot; consume them as the native browser would. ──
  const requests = use(runtime.shortcutRequests)
  const [seenSearchRequest, setSeenSearchRequest] = useState(requests.searchRequest)
  useEffect(() => {
    if (requests.searchRequest === seenSearchRequest) return
    setSeenSearchRequest(requests.searchRequest)
    setWorkspaceDialog(current => (current?.kind === 'add' ? null : current))
    if (!wide || searchInput.current?.closest('[inert]')) {
      setSearchOnExpand(true)
      expandSidebar?.()
    } else {
      changeSearchExpanded(true)
      focusSearch()
    }
  }, [requests.searchRequest])
  useEffect(() => {
    if (!requests.addRequested) return
    setWorkspaceDialog({ kind: 'add' })
    runtime.closeAddRequest()
  }, [requests.addRequested, runtime])

  // ── Row environment ──
  const ready = backend.status === 'ready'
  const open = useCallback((row: Row) => {
    if (row.native.archived) { runtime.notify(t('toast.archivedNotOpenable')); return }
    runtime.open(row.sessionId)
  }, [runtime, t])
  // The translator is stable across locale changes; hover content also reads the current policy.
  const env = useMemo<RowEnv>(() => ({
    runtime, t, now, ready, statusGrouping: groupBy === 'status', menu, open,
  }), [runtime, t, locale, now, ready, groupBy, menu, open, backend.kind, backend.policy])

  // ── Collapse state and the native "show more" watermark ──
  const isCollapsed = (key: string, fallback: boolean): boolean => prefs.collapsed[key] ?? fallback
  const setCollapsed = (key: string, collapsed: boolean) => {
    setPrefs({ collapsed: { ...runtime.prefs.getSnapshot().collapsed, [key]: collapsed } })
  }
  const [marks, setMarks] = useState<Readonly<Record<string, number>>>({})
  const [motionKey, setMotionKey] = useState(0)
  const dropMark = (key: string) => {
    if (marks[key] === undefined) return
    setMarks(({ [key]: _dropped, ...rest }) => rest)
    setMotionKey(value => value + 1)
  }

  // Native behavior: the workspace holding the current session opens once, unless the user chose otherwise.
  const currentWorkspaceKey = useMemo(() => {
    if (groupBy !== 'workspace' || currentId === undefined) return undefined
    const owner = wide ? current?.workspaceId : workspaces.items.find(workspace => workspace.sessionIds.includes(currentId))?.workspaceId
    return `workspace:${owner ?? ''}`
  }, [groupBy, currentId, wide, current, workspaces])
  useEffect(() => {
    if (groupBy !== 'workspace' || currentWorkspaceKey === undefined) return
    if (runtime.prefs.getSnapshot().collapsed[currentWorkspaceKey] !== undefined) return
    setCollapsed(currentWorkspaceKey, false)
  }, [groupBy, currentWorkspaceKey])

  const locateCurrent = () => {
    if (current === undefined) return
    clearSearch()
    if (!visibleUnder(current, archivedFilter)) {
      setPrefs({ archivedFilter: current.native.archived ? 'show' : 'default' })
    }
    if (groupBy === 'workspace' && currentWorkspaceKey !== undefined && isCollapsed(currentWorkspaceKey, true)) {
      setCollapsed(currentWorkspaceKey, false)
    }
    setLocateTarget(current.sessionId)
  }

  const finishLocate = useCallback(() => { setLocateTarget(null) }, [])
  useLayoutEffect(() => {
    if (groupBy === 'flat' || locateTarget === null || !wide || normalizedQuery !== '') return
    const selected = listArea.current?.querySelectorAll<HTMLElement>('.t3sb-session-row[aria-selected="true"]') ?? []
    const row = Array.from(selected).find(element => element.dataset['sessionId'] === locateTarget)
    if (row !== undefined) {
      row.focus({ preventScroll: true })
      row.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    }
    setLocateTarget(null)
  }, [groupBy, locateTarget, normalizedQuery, wide])

  const closeSnooze = (sessionId: string) => {
    if (runtime.snoozeRequest.getSnapshot() !== sessionId) return
    setSnoozeFocusTarget(sessionId)
    runtime.snoozeRequest.set(null)
  }

  const closeResume = (sessionId: string) => {
    if (runtime.resumeRequest.getSnapshot() !== sessionId) return
    setSnoozeFocusTarget(sessionId)
    runtime.resumeRequest.set(null)
  }

  useEffect(() => {
    if (snoozeFocusTarget === null || snoozeTarget !== null || resumeTarget !== null) return
    // Wait for the host modal to release its focus trap before restoring focus.
    const frame = requestAnimationFrame(() => {
      const rows = listArea.current?.querySelectorAll<HTMLElement>('.t3sb-session-row[data-session-id]') ?? []
      const row = Array.from(rows).find(element => element.dataset['sessionId'] === snoozeFocusTarget)
      const trigger = row?.querySelector<HTMLElement>('[data-action="more"]')
      trigger?.focus({ preventScroll: true })
      if (document.activeElement !== trigger) {
        (row ?? searchButton.current)?.focus({ preventScroll: true })
      }
      setSnoozeFocusTarget(null)
    })
    return () => { cancelAnimationFrame(frame) }
  }, [snoozeFocusTarget, snoozeTarget, resumeTarget])

  const locateNotice = (
    <div className="t3sb-locate">
      <span>{t('locate.hidden')}</span>
      <button type="button" className="t3sb-empty-action" onClick={locateCurrent}>{t('locate.action')}</button>
    </div>
  )

  const rowKeys: string[] = []
  const required: Record<string, number> = {}
  /** Session rows of one expanded group, capped by its watermark, plus the Show more / Show less control. */
  const groupBody = (markKey: string, groupRows: readonly Row[], capped: boolean, showPin: boolean): ReactNode => {
    let visible = groupRows
    let overflow: ReactNode = null
    if (capped) {
      const baseline = requiredWatermark(groupRows)
      required[markKey] = baseline
      const watermark = Math.max(marks[markKey] ?? WATERMARK_BASE, baseline)
      const collapsedView = watermarkRows(groupRows, baseline)
      const shown = watermarkRows(groupRows, watermark)
      visible = shown.rows
      if (collapsedView.hiddenCount > 0) {
        const expanded = shown.hiddenCount === 0
        rowKeys.push(`overflow:${markKey}`)
        overflow = (
          <button key={`overflow:${markKey}`} type="button" className="t3sb-overflow-button" data-row-key={`overflow:${markKey}`}
            aria-expanded={expanded}
            onClick={() => {
              if (expanded) { dropMark(markKey); return }
              setMarks(current => ({ ...current, [markKey]: shown.hiddenCount <= WATERMARK_BASE ? Number.POSITIVE_INFINITY : watermark + WATERMARK_BASE }))
              setMotionKey(value => value + 1)
            }}>
            {expanded ? t('sessions.collapse') : t('sessions.expand', { n: shown.hiddenCount })}
          </button>
        )
      }
    }
    for (const row of visible) rowKeys.push(`session:${row.sessionId}`)
    return <><GroupSessionRows rows={visible} env={env} showPin={showPin} />{overflow}</>
  }

  // Keep raised watermarks monotonic: a row that stops needing attention does not jump out of view.
  useEffect(() => {
    const raise = Object.entries(required).filter(([key, value]) => value > (marks[key] ?? WATERMARK_BASE))
    if (raise.length > 0) setMarks(current => ({ ...current, ...Object.fromEntries(raise) }))
  })

  const leaveArchivedOnly = () => { setPrefs({ archivedFilter: 'default' }) }
  const archivedOnly = archivedFilter === 'only'
  const emptySessions = <EmptySessions archivedOnly={archivedOnly} onLeaveArchivedOnly={leaveArchivedOnly} t={t} />
  const visibleGrouping = wide && normalizedQuery === '' ? groupBy : null
  const sections = useMemo(
    () => visibleGrouping === 'status' ? statusSections(rows, archivedFilter, { workingSection: prefs.workingSection }) : null,
    [visibleGrouping, rows, archivedFilter, prefs.workingSection],
  )
  const ungroupedTitle = visibleGrouping === 'workspace' ? t('group.ungrouped') : ''
  const groups = useMemo(
    () => visibleGrouping === 'workspace' ? workspaceGroups(rows, workspaces, archivedFilter, ungroupedTitle) : null,
    [visibleGrouping, rows, workspaces, archivedFilter, ungroupedTitle],
  )
  const oneList = useMemo(() => visibleGrouping === 'flat' ? flatRows(rows, archivedFilter) : [], [visibleGrouping, rows, archivedFilter])

  let body: ReactNode
  let empty = false
  if (sections !== null) {
    empty = sections.length === 0
    body = sections.map((section) => {
      const key = `status:${section.key}`
      const collapsed = isCollapsed(key, COLLAPSED_BY_DEFAULT.has(section.key))
      rowKeys.push(`group:${key}`)
      const currentRows = section.rows.filter(row => row.current)
      return (
        <div key={key} className="t3sb-group" data-section={section.key}>
          <GroupRow rowKey={`group:${key}`} icon={SECTION_ICON[section.key]} title={t(`section.${section.key}` as Key)}
            expanded={!collapsed} count={section.rows.length} active={collapsed && currentRows.length > 0} t={t}
            onToggle={() => { if (!collapsed) dropMark(key); setCollapsed(key, !collapsed) }} />
          {groupBody(key, collapsed ? currentRows : section.rows, !collapsed && !UNCAPPED.has(section.key), section.key !== 'pinned')}
        </div>
      )
    })
  } else if (groups !== null) {
    empty = groups.length === 0
    body = groups.map((group) => {
      const key = `workspace:${group.key}`
      const expanded = prefs.collapsed[key] === false
      rowKeys.push(`group:${key}`)
      const workspaceId = group.workspaceId
      return (
        <div key={key} className="t3sb-group" data-workspace={group.key}>
          <GroupRow rowKey={`group:${key}`} t={t}
            icon={expanded ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
            title={group.title} expanded={expanded} count={0} active={group.containsCurrent}
            onToggle={() => { if (expanded) dropMark(key); setCollapsed(key, expanded) }}
            menu={workspaceId === null ? undefined : [
              { id: 'rename', label: t('workspace.rename'), icon: workspaceMenuIcons.rename, run: () => { setWorkspaceDialog({ kind: 'rename', workspaceId, title: group.title }) } },
              { id: 'remove', label: t('workspace.remove'), icon: workspaceMenuIcons.remove, danger: true, run: () => { setWorkspaceDialog({ kind: 'remove', workspaceId, title: group.title }) } },
            ]}
            onCreate={workspaceId === null ? undefined : () => { setCollapsed(key, false); runtime.startSession(workspaceId) }}
            hover={group.path === null ? undefined : <WorkspaceHoverContent title={group.title} path={group.path} createdAt={group.createdAt} t={t} />}
            {...(group.path === null ? {} : { copyText: group.path })} />
          {expanded && groupBody(key, group.rows, true, true)}
        </div>
      )
    })
  }
  if (empty) rowKeys.unshift('empty')
  const currentInList = current === undefined || rowKeys.includes(`session:${current.sessionId}`)

  const listReady = sessions.phase === 'ready' && workspaces.phase === 'ready'
  const label = groupBy === 'workspace' ? t('header.workspaces') : t('header.sessions')

  const searchView = () => {
    const currentRemote = remote.query === normalizedQuery ? remote : { query: normalizedQuery, status: 'loading' as const, items: [], hasMore: false }
    const { items: results, truncated } = searchResults(rows, normalizedQuery, currentRemote.items, archivedFilter, runtime.searchLimit)
    const pending = currentRemote.status === 'loading'
    const indexing = currentRemote.indexing
    return (
      <div className="t3sb-tree-body t3sb-wide">
        <div className="t3sb-list">
          {current !== undefined && !pending && !results.some(result => result.row.sessionId === current.sessionId) && locateNotice}
          <div className="t3sb-search-tree" role="tree" aria-label={t('search.results')}>
            {results.map(result => (
              <SearchResultRow key={result.row.sessionId} row={result.row} snippet={result.snippet} highlight={result.highlight} place={result.place}
                env={{ ...env, open: (row) => { if (!row.native.archived) clearSearch(); open(row) } }} />
            ))}
          </div>
          {pending && (
            <div role="status" aria-label={t('search.pending')}>
              {(results.length === 0 ? [0, 1] : [0]).map(i => (
                <div key={i} className="t3sb-skeleton-row" aria-hidden="true">
                  <span className="t3sb-skeleton-dot" />
                  <span className="t3sb-skeleton-bars"><span className="t3sb-skeleton-bar" /><span className="t3sb-skeleton-bar t3sb-skeleton-bar-wide" /></span>
                </div>
              ))}
            </div>
          )}
          {!pending && results.length === 0 && indexing === undefined && <div className="t3sb-empty">{t('search.noMatches')}</div>}
          {!pending && indexing !== undefined && (
            <div className="t3sb-search-status" role="status" data-testid="t3-search-indexing">
              {indexing.reading === true
                ? indexing.total > 0
                  ? t('search.indexing', { indexed: indexing.indexed, total: indexing.total })
                  : t('search.listing')
                : indexing.limited === true ? t('search.limited') : t('search.partial')}
            </div>
          )}
          {(currentRemote.hasMore || truncated) && <div className="t3sb-search-status">{t('search.hasMore', { n: runtime.searchLimit })}</div>}
        </div>
      </div>
    )
  }

  // Arrow keys, Home and End move focus between rows (group headers, sessions, search results)
  // while a row itself has focus; Tab still walks into a row's own buttons.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (groupBy === 'flat' && normalizedQuery === '') return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const rowsInView = [...event.currentTarget.querySelectorAll<HTMLElement>('.t3sb-group-row, .t3sb-session-row, .t3sb-search-row')]
    const index = rowsInView.indexOf(event.target as HTMLElement)
    if (index < 0) return
    const next = nextFocusIndex(event.key, index, rowsInView.length)
    if (next === null) return
    event.preventDefault()
    rowsInView[next]?.focus()
    rowsInView[next]?.scrollIntoView({ block: 'nearest' })
  }

  const connection = backend.status === 'stale'
    ? t('stale')
    : backend.kind === 'connecting' && backend.failure === 'transient' ? t('connecting.retry') : null

  const addButton = (
    <Tooltip label={t('workspace.add')} side="bottom" delayMs={500} portal>
      <button type="button" className="t3sb-header-button" aria-label={t('workspace.add')} data-testid="t3-add-workspace"
        onClick={() => { setWorkspaceDialog({ kind: 'add' }) }}>
        <IconProjectAddOutlineRegular size={wide ? 16 : 18} />
      </button>
    </Tooltip>
  )

  return (
    <div className={cx('t3sb-root', !wide && 't3sb-rail')} data-t3-sidebar={groupBy} data-backend={backend.kind}>
      <div className={cx('t3sb-section-header', wide && searchMotion && 't3sb-search-motion')}>
        {wide && <span className={cx('t3sb-section-label', 't3sb-wide', searchExpanded && 't3sb-section-label-hidden')}>{label}</span>}
        {wide && (
          <div className={cx('t3sb-search-slot', searchExpanded && 't3sb-search-slot-expanded')}>
            <div ref={searchRoot} className={cx('t3sb-search', searchExpanded && 't3sb-search-expanded')}
              onClick={() => { changeSearchExpanded(true); focusSearch() }}>
              <Tooltip label={t('search.tooltip')} side="bottom" delayMs={500} disabled={searchExpanded} portal>
                <button ref={searchButton} type="button" className="t3sb-search-button" aria-label={t('search.open')} aria-expanded={searchExpanded}
                  data-testid="t3-search" onClick={() => { changeSearchExpanded(true) }}>
                  <IconSearchOutlineRegular size={searchExpanded ? 11 : 14} />
                </button>
              </Tooltip>
              <input ref={searchInput} className="t3sb-search-input" type="text" placeholder={t(historySearch ? 'search.placeholderHistory' : 'search.placeholder')}
                aria-label={t(historySearch ? 'search.placeholderHistory' : 'search.placeholder')} value={query} tabIndex={searchExpanded ? 0 : -1}
                onChange={(event) => { setQuery(sanitizeQuery(event.target.value)) }}
                onKeyDown={(event) => { if (event.key === 'Escape') clearSearch() }} />
              {searchExpanded && (
                <button type="button" className="t3sb-clear-button" aria-label={t('search.clear')}
                  onClick={(event) => { event.stopPropagation(); clearSearch() }}>
                  <IconCloseFillRegular />
                </button>
              )}
            </div>
          </div>
        )}
        <div className={cx('t3sb-header-actions', wide && searchExpanded && 't3sb-header-actions-hidden')}>
          {wide && (
            <ViewOptionsMenu groupBy={groupBy} archivedFilter={archivedFilter} t={t} openSettings={runtime.settingsAction()}
              onGroupBy={(mode) => { setPrefs({ groupBy: mode }) }}
              onArchivedFilter={(filter) => { setPrefs({ archivedFilter: filter }) }} />
          )}
          {addButton}
        </div>
        {/* The native header ends with its add-workspace flow's zero-width anchor; the extra
            flex gap it creates is part of the native geometry, so keep an empty stand-in. */}
        {wide && <span aria-hidden="true" />}
      </div>

      {!wide && (
        <div className="t3sb-search">
          <Tooltip label={t('search.tooltip')} portal>
            <button ref={searchButton} type="button" className="t3sb-search-button" aria-label={t('search.open')}
              onClick={() => { setSearchOnExpand(true); expandSidebar?.() }}>
              <IconSearchOutlineRegular size={18} />
            </button>
          </Tooltip>
        </div>
      )}

      {wide && connection !== null && (
        <div className="t3sb-connection" role="status" title={backend.reason ?? undefined}>
          <StateDot state="warning" />
          <span>{connection}</span>
        </div>
      )}

      <div ref={listArea} className="t3sb-list-area" onKeyDown={onListKeyDown}>
        {wide && (normalizedQuery !== '' ? searchView() : (
          <HoverCardGroup className="t3sb-tree-body t3sb-wide">
            {groupBy === 'flat' ? (
              <FlatSessionList key={archivedFilter} rows={oneList} env={env} label={label}
                currentId={current?.sessionId} locateNotice={locateNotice} empty={emptySessions}
                locateTarget={locateTarget} onLocated={finishLocate} snoozeTarget={snoozeTarget} snoozeFocusTarget={snoozeFocusTarget} />
            ) : (
              <>
                {!currentInList && locateNotice}
                <AnimatedRows className="t3sb-list" role="tree" label={label}
                  rowKeys={rowKeys} ready={listReady} resetKey={JSON.stringify([groupBy, archivedFilter, motionKey])}>
                  {empty && emptySessions}
                  {body}
                </AnimatedRows>
              </>
            )}
            <span className="t3sb-fade" />
          </HoverCardGroup>
        ))}
      </div>

      {snoozeTarget !== null && <SnoozeDialog key={snoozeTarget} runtime={runtime} sessionId={snoozeTarget} now={now}
        onClose={() => { closeSnooze(snoozeTarget) }} />}
      {resumeTarget !== null && <ResumeDialog key={resumeTarget} runtime={runtime} sessionId={resumeTarget}
        onClose={() => { closeResume(resumeTarget) }} />}
      {workspaceDialog?.kind === 'add' && <AddWorkspaceDialog runtime={runtime} onClose={() => { setWorkspaceDialog(null) }} />}
      {workspaceDialog?.kind === 'rename' && (
        <RenameWorkspaceDialog runtime={runtime} workspaceId={workspaceDialog.workspaceId} title={workspaceDialog.title} onClose={() => { setWorkspaceDialog(null) }} />
      )}
      {workspaceDialog?.kind === 'remove' && (
        <RemoveWorkspaceDialog runtime={runtime} workspaceId={workspaceDialog.workspaceId} title={workspaceDialog.title} onClose={() => { setWorkspaceDialog(null) }} />
      )}
      {notice !== null && <Toast key={notice.seq} text={notice.text} holdMs={5000} onDone={() => { runtime.notice.set(null) }} />}
    </div>
  )
}
