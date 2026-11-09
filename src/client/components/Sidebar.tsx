/**
 * The `sidebar.workspaces` occupant: task view (default) and project view
 * over one shared row model.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type RefCallback } from 'react'
import { DAY_MS, type Placement } from '../../domain/types.ts'
import { snoozePresets, validateSnoozeUntil } from '../../domain/time.ts'
import type { Key } from '../locales.ts'
import {
  archivedRows, buildRows, currentHiddenByFilter, projectGroups, taskSections,
  type Filter, type ProjectGroup, type Row,
} from '../model.ts'
import type { Readable } from '../store.ts'
import type { Prefs, Runtime } from '../runtime.ts'

const use = <T,>(source: Readable<T>): T => useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)

const DEFAULT_COLLAPSED: Record<Placement, boolean> = {
  pinned: false, active: false, working: true, snoozed: true, settled: true,
}
const SETTLED_PAGE = 10
const SETTLED_STEP = 25

export interface SidebarProps {
  readonly runtime: Runtime
  readonly wide?: boolean
  readonly useSectionScroller?: () => { bindScrollerRef: RefCallback<HTMLElement> }
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

const noopScroller = { bindScrollerRef: () => {} }

export function TaskSidebar({ runtime, wide = true, useSectionScroller }: SidebarProps) {
  const { bindScrollerRef } = (useSectionScroller ?? (() => noopScroller))()
  use(runtime.locale)
  const t = runtime.t
  const sessions = use(runtime.sessions)
  const workspaces = use(runtime.workspaces)
  const status = use(runtime.status)
  const backend = use(runtime.backend)
  const prefs = use(runtime.prefs)
  const snoozeTarget = use(runtime.snoozeRequest)
  const notice = use(runtime.notice)
  const now = useNow(30_000) + backend.clockOffset
  const [query, setQuery] = useState('')
  const [contentHits, setContentHits] = useState<{ ids: ReadonlySet<string>; hasMore: boolean } | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settledLimit, setSettledLimit] = useState(SETTLED_PAGE)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    runtime.prefs.set({ ...runtime.prefs.getSnapshot(), ...patch })
  }, [runtime])

  const rows = useMemo(
    () => buildRows({ sessions, workspaces, status, tasks: backend.tasks, lastSeen: prefs.lastSeen, now }),
    [sessions, workspaces, status, backend.tasks, prefs.lastSeen, now],
  )
  const current = rows.find(row => row.current)

  // Mark the current session's latest result as read while this window has focus.
  useEffect(() => {
    const seq = current?.facts.summary.lastTurnEnd?.seq
    if (current === undefined || seq === undefined) return
    if (typeof document !== 'undefined' && !document.hasFocus()) return
    if ((prefs.lastSeen[current.sessionId] ?? -1) >= seq) return
    setPrefs({ lastSeen: { ...prefs.lastSeen, [current.sessionId]: seq } })
  }, [current, prefs.lastSeen, setPrefs])

  // Content search: explicit mode, 200 ms debounce, stale results dropped.
  useEffect(() => {
    const trimmed = query.trim()
    if (!prefs.includeContent || trimmed === '') { setContentHits(null); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      runtime.search(trimmed, controller.signal).then((result) => {
        if (!controller.signal.aborted) setContentHits({ ids: new Set(result.ids), hasMore: result.hasMore })
      }, () => { if (!controller.signal.aborted) setContentHits(null) })
    }, 200)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [query, prefs.includeContent, runtime])

  const filter: Filter = { scope: prefs.scope, query, contentHits: contentHits?.ids ?? null }
  // Same scope + search predicate the sections and project groups render with.
  const currentOutOfScope = currentHiddenByFilter(current, filter)

  const collapsedKey = (id: string) => `${prefs.view}:${id}`
  const isCollapsed = (id: string, fallback: boolean): boolean => prefs.collapsed[collapsedKey(id)] ?? fallback
  const toggle = (id: string, fallback: boolean) => {
    setPrefs({ collapsed: { ...prefs.collapsed, [collapsedKey(id)]: !isCollapsed(id, fallback) } })
  }

  const locateCurrent = () => {
    if (current === undefined) return
    setQuery('')
    setPrefs({ scope: null })
    if (current.placement !== null) setPrefs({ scope: null, collapsed: { ...prefs.collapsed, [collapsedKey(current.placement)]: false } })
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(current.sessionId)}"] .t3sb-row-main`)?.focus()
    })
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const targets = [...(rootRef.current?.querySelectorAll<HTMLElement>('.t3sb-row-main, .t3sb-section-header') ?? [])]
    const index = targets.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    let next: number | null = null
    if (event.key === 'ArrowDown') next = Math.min(targets.length - 1, index + 1)
    if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = targets.length - 1
    if (next !== null) { event.preventDefault(); targets[next]?.focus() }
    const active = targets[index]
    if (active?.classList.contains('t3sb-section-header')) {
      const expanded = active.getAttribute('aria-expanded') === 'true'
      if ((event.key === 'ArrowLeft' && expanded) || (event.key === 'ArrowRight' && !expanded)) { event.preventDefault(); active.click() }
    }
  }

  if (!wide) {
    const sections = taskSections(rows, { scope: null, query: '', contentHits: null })
    const attention = sections.find(section => section.placement === 'active')?.rows.length ?? 0
    return (
      <div className="t3sb-rail" data-t3-sidebar="rail">
        <span className="t3sb-rail-dot" title={t('section.active')}>{attention}</span>
      </div>
    )
  }

  const sections = taskSections(rows, filter)
  const groups = projectGroups(rows, workspaces, filter, t('scope.ungrouped'))
  const archived = archivedRows(rows, filter)
  const anyMatch = sections.some(section => section.rows.length > 0)

  return (
    <div className="t3sb-root" ref={rootRef} data-t3-sidebar={prefs.view} data-backend={backend.kind}>
      <div className="t3sb-toolbar">
        <div className="t3sb-seg" role="group" aria-label={t('view.toggle')}>
          <button type="button" aria-pressed={prefs.view === 'tasks'} onClick={() => setPrefs({ view: 'tasks' })} data-testid="t3-view-tasks">{t('view.tasks')}</button>
          <button type="button" aria-pressed={prefs.view === 'projects'} onClick={() => setPrefs({ view: 'projects' })} data-testid="t3-view-projects">{t('view.projects')}</button>
        </div>
        <select aria-label={t('scope.label')} value={prefs.scope ?? ''} onChange={event => setPrefs({ scope: event.target.value === '' ? null : event.target.value })}>
          <option value="">{t('scope.all')}</option>
          {workspaces.items.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>)}
          <option value="ungrouped">{t('scope.ungrouped')}</option>
        </select>
        <span className="t3sb-spacer" />
        <button type="button" className="t3sb-icon" aria-label={t('settings.open')} title={t('settings.open')} aria-expanded={showSettings} onClick={() => setShowSettings(value => !value)} data-testid="t3-settings">⚙</button>
      </div>
      <div className="t3sb-search" data-has-query={query.trim() !== ''}>
        <input type="search" value={query} placeholder={t('search.placeholder')} aria-label={t('search.placeholder')}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape') setQuery('') }} />
        <label title={prefs.includeContent ? t('search.withContent') : t('search.titleOnly')}>
          <input type="checkbox" checked={prefs.includeContent} onChange={event => setPrefs({ includeContent: event.target.checked })} />
          {t('search.content')}
        </label>
      </div>
      {backend.status === 'stale' && <div className="t3sb-banner" role="status">{t('stale')}</div>}
      {notice !== null && <div className="t3sb-banner" role="status" key={notice.seq}>{notice.text}</div>}
      {currentOutOfScope && (
        <div className="t3sb-banner">
          <span>{t('current.outOfScope')}</span>
          <button type="button" onClick={locateCurrent}>{t('current.locate')}</button>
        </div>
      )}
      {query.trim() !== '' && contentHits?.hasMore === true && (
        <div className="t3sb-banner" role="status">{t('search.hasMore', { n: runtime.searchLimit })}</div>
      )}
      {showSettings && <SettingsPanel runtime={runtime} onClose={() => setShowSettings(false)} />}
      {snoozeTarget !== null && <SnoozeDialog runtime={runtime} sessionId={snoozeTarget} now={now} />}
      <div className="t3sb-scroll" ref={bindScrollerRef} onKeyDown={onListKeyDown}>
        {showArchived ? (
          <ArchiveList rows={archived} runtime={runtime} onBack={() => setShowArchived(false)} />
        ) : prefs.view === 'tasks' ? (
          <>
            {sections.map((section) => {
              const fallback = DEFAULT_COLLAPSED[section.placement]
              const collapsed = isCollapsed(section.placement, fallback)
              const limit = section.placement === 'settled' ? settledLimit : Number.POSITIVE_INFINITY
              const shown = collapsed
                ? section.rows.filter(row => row.current)
                : section.rows.slice(0, limit).concat(section.rows.slice(limit).filter(row => row.current))
              return (
                <section key={section.placement} className="t3sb-section" data-section={section.placement} aria-label={t(`section.${section.placement}` as Key)}>
                  <button type="button" className="t3sb-section-header" aria-expanded={!collapsed} onClick={() => toggle(section.placement, fallback)}>
                    <span className="t3sb-chevron" aria-hidden="true">▾</span>
                    <span>{t(`section.${section.placement}` as Key)}</span>
                    <span className="t3sb-count" aria-label={t('section.count', { n: section.rows.length })}>{section.rows.length}</span>
                  </button>
                  {shown.length > 0 && <RowList rows={shown} runtime={runtime} now={now} showProject />}
                  {!collapsed && section.rows.length > limit && (
                    <button type="button" className="t3sb-show-more" onClick={() => setSettledLimit(value => value + SETTLED_STEP)}>
                      {t('section.showMore', { n: Math.min(SETTLED_STEP, section.rows.length - limit) })}
                    </button>
                  )}
                </section>
              )
            })}
            {!anyMatch && query.trim() !== '' && <div className="t3sb-empty">{t('search.empty')}</div>}
          </>
        ) : (
          <>
          <AddProject runtime={runtime} />
          {groups.map(group => (
            <ProjectSection key={group.workspaceId ?? 'ungrouped'} group={group} runtime={runtime} now={now}
              collapsed={isCollapsed(`p:${group.workspaceId ?? 'ungrouped'}`, false)}
              laterCollapsed={isCollapsed(`l:${group.workspaceId ?? 'ungrouped'}`, true)}
              onToggle={() => toggle(`p:${group.workspaceId ?? 'ungrouped'}`, false)}
              onToggleLater={() => toggle(`l:${group.workspaceId ?? 'ungrouped'}`, true)} />
          ))}
          </>
        )}
        {!showArchived && archived.length > 0 && (
          <button type="button" className="t3sb-link" onClick={() => setShowArchived(true)} data-testid="t3-archive">{t('archive.show')} ({archived.length})</button>
        )}
      </div>
    </div>
  )
}

function statusLabel(row: Row, t: Runtime['t'], now: number): string {
  if (row.placement === 'snoozed' && row.record?.disposition.kind === 'snoozed') {
    return t('status.snoozedUntil', { time: formatTime(row.record.disposition.until, now) })
  }
  if (row.placement === 'settled' && row.record?.disposition.kind === 'settled') {
    const disposition = row.record.disposition
    if (disposition.reason === 'idle-timeout' && disposition.deadline !== undefined && disposition.anchorAt !== undefined) {
      return t('status.settledAuto', { days: Math.round((disposition.deadline - disposition.anchorAt) / DAY_MS) })
    }
    return t('status.settledManual')
  }
  return t(`status.${row.status}` as Key)
}

function formatTime(at: number, now: number): string {
  const date = new Date(at)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function RowList({ rows, runtime, now, showProject }: { rows: readonly Row[]; runtime: Runtime; now: number; showProject: boolean }) {
  return (
    <ul className="t3sb-list">
      {rows.map(row => <TaskRow key={row.sessionId} row={row} runtime={runtime} now={now} showProject={showProject} />)}
    </ul>
  )
}

function TaskRow({ row, runtime, now, showProject }: { row: Row; runtime: Runtime; now: number; showProject: boolean }) {
  const t = runtime.t
  const title = row.untitled ? t('row.untitled') : row.title
  const label = statusLabel(row, t, now)
  const showBadge = row.status !== 'idle' || row.placement === 'snoozed' || row.placement === 'settled'
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    runtime.openSessionMenu(row.sessionId, title, { x: event.clientX, y: event.clientY })
  }
  return (
    <li className="t3sb-row" data-session-id={row.sessionId} data-status={row.status} aria-current={row.current ? 'true' : undefined} onContextMenu={openMenu}>
      <span className="t3sb-dot" data-status={row.status} aria-hidden="true" />
      <button type="button" className="t3sb-row-main" onClick={() => runtime.open(row.sessionId)}
        title={row.workspaceTitle === null ? title : `${title} — ${row.workspaceTitle}`}
        aria-label={`${title}, ${label}`}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            runtime.openSessionMenu(row.sessionId, title, { x: rect.left + 16, y: rect.bottom })
          }
        }}>
        <span className="t3sb-title" data-untitled={row.untitled}>{title}</span>
        {showProject && row.workspaceTitle !== null && <span className="t3sb-sub"><span>{row.workspaceTitle}</span></span>}
      </button>
      {showBadge && <span className="t3sb-badge" data-status={row.status}>{label}</span>}
      <button type="button" className="t3sb-icon t3sb-more" aria-label={t('row.more', { title })}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          runtime.openSessionMenu(row.sessionId, title, { x: rect.left, y: rect.bottom })
        }}>⋯</button>
    </li>
  )
}

function ProjectSection(props: {
  group: ProjectGroup; runtime: Runtime; now: number; collapsed: boolean; laterCollapsed: boolean
  onToggle: () => void; onToggleLater: () => void
}) {
  const { group, runtime, now, collapsed, laterCollapsed } = props
  const t = runtime.t
  const total = group.primary.length + group.later.length
  const currentLater = group.later.filter(row => row.current)
  const [editing, setEditing] = useState(false)
  return (
    <section className="t3sb-section" data-project={group.workspaceId ?? 'ungrouped'} aria-label={group.title}>
      <div className="t3sb-project-header">
        <button type="button" className="t3sb-section-header" aria-expanded={!collapsed} onClick={props.onToggle} title={group.path ?? undefined}>
          <span className="t3sb-chevron" aria-hidden="true">▾</span>
          <span className="t3sb-project-title">{group.title}</span>
          <span className="t3sb-count">{total}</span>
        </button>
        {group.workspaceId !== null && (
          <>
            <button type="button" className="t3sb-icon" aria-label={t('project.new', { title: group.title })} title={t('project.new', { title: group.title })}
              onClick={() => runtime.startSession(group.workspaceId!)}>＋</button>
            <button type="button" className="t3sb-icon" aria-label={t('project.actions', { title: group.title })} aria-expanded={editing}
              onClick={() => setEditing(value => !value)}>⋯</button>
          </>
        )}
      </div>
      {editing && group.workspaceId !== null && (
        <ProjectActions runtime={runtime} workspaceId={group.workspaceId} title={group.title} onDone={() => setEditing(false)} />
      )}
      {collapsed ? (
        group.primary.some(row => row.current) || currentLater.length > 0
          ? <RowList rows={[...group.primary, ...group.later].filter(row => row.current)} runtime={runtime} now={now} showProject={false} />
          : null
      ) : (
        <>
          {total === 0 && <div className="t3sb-empty">{t('project.empty')}</div>}
          {group.primary.length > 0 && <RowList rows={group.primary} runtime={runtime} now={now} showProject={false} />}
          {group.later.length > 0 && (
            <>
              <button type="button" className="t3sb-section-header" aria-expanded={!laterCollapsed} onClick={props.onToggleLater}>
                <span className="t3sb-chevron" aria-hidden="true">▾</span>
                <span>{t('project.later', { n: group.later.length })}</span>
              </button>
              {(laterCollapsed ? currentLater : group.later).length > 0 && (
                <RowList rows={laterCollapsed ? currentLater : group.later} runtime={runtime} now={now} showProject={false} />
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}

function AddProject({ runtime }: { runtime: Runtime }) {
  const t = runtime.t
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (path.trim() === '') return
    try {
      await runtime.createWorkspace(path.trim())
      setPath(''); setOpen(false); setError(null)
    } catch (reason) {
      setError(t('project.failed', { reason: reason instanceof Error ? reason.message : String(reason) }))
    }
  }
  if (!open) return <button type="button" className="t3sb-link" onClick={() => setOpen(true)} data-testid="t3-add-project">＋ {t('project.add')}</button>
  return (
    <div className="t3sb-panel" role="group" aria-label={t('project.add')} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}>
      <label>
        <input type="text" value={path} placeholder={t('project.path')} aria-label={t('project.path')} autoFocus style={{ flex: 1, font: 'inherit' }}
          onChange={event => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} />
      </label>
      {error !== null && <p className="t3sb-error" role="alert">{error}</p>}
      <div className="t3sb-actions">
        <button type="button" onClick={() => { void runtime.pickDirectory().then((picked) => { if (picked !== null) setPath(picked) }) }}>{t('project.browse')}</button>
        <button type="button" data-primary="true" onClick={() => { void submit() }}>{t('project.create')}</button>
      </div>
    </div>
  )
}

function ProjectActions({ runtime, workspaceId, title, onDone }: { runtime: Runtime; workspaceId: string; title: string; onDone: () => void }) {
  const t = runtime.t
  const [name, setName] = useState(title)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<void>) => {
    try { await action(); onDone() } catch (reason) {
      setError(t('project.failed', { reason: reason instanceof Error ? reason.message : String(reason) }))
    }
  }
  return (
    <div className="t3sb-panel" role="group" aria-label={t('project.actions', { title })} onKeyDown={(event) => { if (event.key === 'Escape') onDone() }}>
      <label>
        <input type="text" value={name} aria-label={t('project.rename')} style={{ flex: 1, font: 'inherit' }} onChange={event => setName(event.target.value)} />
        <button type="button" onClick={() => { void run(() => runtime.renameWorkspace(workspaceId, name.trim())) }} disabled={name.trim() === '' || name === title}>{t('project.rename')}</button>
      </label>
      {confirming ? (
        <>
          <p>{t('project.deleteConfirm', { title })}</p>
          <div className="t3sb-actions">
            <button type="button" onClick={() => setConfirming(false)}>{t('snooze.cancel')}</button>
            <button type="button" data-primary="true" onClick={() => { void run(() => runtime.deleteWorkspace(workspaceId)) }}>{t('project.delete')}</button>
          </div>
        </>
      ) : (
        <button type="button" className="t3sb-link" onClick={() => setConfirming(true)}>{t('project.delete')}</button>
      )}
      {error !== null && <p className="t3sb-error" role="alert">{error}</p>}
    </div>
  )
}

function ArchiveList({ rows, runtime, onBack }: { rows: readonly Row[]; runtime: Runtime; onBack: () => void }) {
  const t = runtime.t
  return (
    <section className="t3sb-section" aria-label={t('archive.title')}>
      <button type="button" className="t3sb-link" onClick={onBack}>← {t('archive.hide')}</button>
      <ul className="t3sb-list">
        {rows.map(row => (
          <li key={row.sessionId} className="t3sb-row" data-session-id={row.sessionId}>
            <span className="t3sb-row-main"><span className="t3sb-title">{row.untitled ? t('row.untitled') : row.title}</span></span>
            <button type="button" className="t3sb-link" onClick={() => runtime.unarchive(row.sessionId)}>{t('archive.restore')}</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function toLocalInput(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function SnoozeDialog({ runtime, sessionId, now }: { runtime: Runtime; sessionId: string; now: number }) {
  const t = runtime.t
  const [value, setValue] = useState(() => toLocalInput(snoozePresets(now).find(preset => preset.id === 'tomorrow-09')?.until ?? now + 3_600_000))
  const [error, setError] = useState<string | null>(null)
  const close = () => runtime.snoozeRequest.set(null)
  const submit = async () => {
    const until = new Date(value).getTime()
    if (Number.isNaN(until) || validateSnoozeUntil(until, now) !== null) { setError(t('snooze.invalid')); return }
    const result = await runtime.command(sessionId, { kind: 'snooze', until })
    if (result.ok) close()
    else setError(t(`error.${result.code}` as Key) === `error.${result.code}` ? t('error.generic', { code: result.code }) : t(`error.${result.code}` as Key))
  }
  return (
    <div className="t3sb-panel" role="dialog" aria-modal="false" aria-label={t('snooze.title')}
      onKeyDown={(event) => { if (event.key === 'Escape') close() }}>
      <h2>{t('snooze.title')}</h2>
      <p>{t('snooze.note')}</p>
      <input type="datetime-local" value={value} onChange={event => setValue(event.target.value)} autoFocus aria-label={t('snooze.title')} />
      {error !== null && <p className="t3sb-error" role="alert">{error}</p>}
      <div className="t3sb-actions">
        <button type="button" onClick={close}>{t('snooze.cancel')}</button>
        <button type="button" data-primary="true" onClick={() => { void submit() }}>{t('snooze.confirm')}</button>
      </div>
    </div>
  )
}

function reasonKey(reason: string): Key {
  if (reason === 'snooze-expired' || reason === 'idle-timeout') return `reason.${reason}`
  if (reason.startsWith('manual:')) return 'reason.manual'
  return 'reason.activity'
}

function SettingsPanel({ runtime, onClose }: { runtime: Runtime; onClose: () => void }) {
  const t = runtime.t
  const backend = use(runtime.backend)
  const [enabled, setEnabled] = useState(backend.policy.autoSettleAfterDays !== null)
  const [days, setDays] = useState(backend.policy.autoSettleAfterDays ?? 7)
  const [keepFailures, setKeepFailures] = useState(backend.policy.keepUnacknowledgedFailures)
  const [message, setMessage] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly { at: number; sessionId: string; from: string; to: string; reason: string }[]>([])
  const host = backend.kind === 'host'
  useEffect(() => {
    if (!host) return
    let live = true
    void runtime.listTransitions(20).then((entries) => { if (live) setHistory(entries) })
    return () => { live = false }
  }, [host, runtime, backend.policy.revision])
  const titleOf = (id: string) => runtime.sessions.getSnapshot().byId[id]?.displayTitle ?? id.slice(0, 8)
  const save = async () => {
    const clamped = Math.min(90, Math.max(1, Math.round(days)))
    const result = await runtime.setPolicy(enabled ? clamped : null, keepFailures)
    setMessage(result.ok ? t('settings.saved') : t('error.generic', { code: result.code }))
  }
  return (
    <div className="t3sb-panel" role="dialog" aria-label={t('settings.title')} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
      <h2>{t('settings.title')}</h2>
      <p data-testid="t3-backend-note">{host ? t('settings.backend.host') : t('settings.backend.local')}</p>
      {host && (
        <>
          <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{t('settings.autoSettle')}</label>
          <label>{t('settings.daysLabel')}
            <input type="number" min={1} max={90} step={1} value={days} disabled={!enabled} onChange={event => setDays(Number(event.target.value))} />
          </label>
          <label><input type="checkbox" checked={keepFailures} disabled={!enabled} onChange={event => setKeepFailures(event.target.checked)} />{t('settings.keepFailures')}</label>
          <div className="t3sb-actions">
            {message !== null && <span role="status">{message}</span>}
            <button type="button" data-primary="true" onClick={() => { void save() }}>{t('settings.save')}</button>
          </div>
          <h2>{t('settings.history')}</h2>
          {history.length === 0 ? <p>{t('settings.historyEmpty')}</p> : (
            <ul className="t3sb-history">
              {history.map(entry => (
                <li key={`${entry.at}-${entry.sessionId}`}>
                  <span className="t3sb-history-title">{titleOf(entry.sessionId)}</span>
                  <span>{t(`state.${entry.from}` as Key)} → {t(`state.${entry.to}` as Key)} · {t(reasonKey(entry.reason))}</span>
                  <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
