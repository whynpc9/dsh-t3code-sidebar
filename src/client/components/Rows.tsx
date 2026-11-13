/**
 * Row components, mirroring the native workspace browser's rows: a 32px group
 * header (icon that swaps to a chevron on hover), a 32px session row (status
 * dot, marquee title, relative time; hover swaps the time for the action
 * strip) and a 48px search result. All data and callbacks arrive via props.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import {
  HoverCard, IconAlarmClockOutlineRegular, IconArchiveOutlineRegular, IconCheckCircleOutlineRegular,
  IconEditOutlineRegular, IconEllipsisOutlineRegular, IconNewChatOutlineRegular, IconPinFillRegular, IconPinOutlineRegular,
  IconTrashOutlineRegular, IconTriangleRightFillRegular, IconUnarchiveOutlineRegular,
  Menu, relativeTime, StateDot, Tooltip, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { settle } from '../../domain/commands.ts'
import { DAY_MS, emptyRecord } from '../../domain/types.ts'
import type { RowStatus } from '../../domain/placement.ts'
import type { Key } from '../locales.ts'
import { heldResultOf, type Row } from '../model.ts'
import type { Runtime } from '../runtime.ts'

export const cx = (...names: readonly (string | false | null | undefined)[]): string => names.filter(Boolean).join(' ')

type Translate = Runtime['t']

/** Menu gesture bindings the renderer hands every slot occupant (`useContextMenu()`). */
export interface ContextMenuBindings {
  getTriggerProps(
    target: { kind: 'session'; value: { sessionId: string; displayTitle: string } } | undefined,
    handlers?: { onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void },
  ): Record<string, unknown>
}

/** What every session row needs from its list. */
export interface RowEnv {
  readonly runtime: Runtime
  readonly t: Translate
  readonly now: number
  /** Whether the Host baseline is fresh (task actions are disabled otherwise). */
  readonly ready: boolean
  /** The status grouping already names the task state, so rows skip its indicator there. */
  readonly statusGrouping: boolean
  readonly menu: ContextMenuBindings | undefined
  /** Session id whose context menu is open. */
  readonly menuSessionId: string | null
  /** Open one session (archived ones explain instead). */
  readonly open: (row: Row) => void
}

// ── Status presentation ──────────────────────────────────────────────────────

const DOT: Record<RowStatus, StateDotState> = {
  approval: 'warning',
  input: 'warning',
  attention: 'warning',
  'needs-check': 'warning',
  running: 'ongoing',
  failed: 'error',
  'new-result': 'done',
  unknown: 'idle',
  idle: 'idle',
}

const COMPACT: Partial<Record<RowStatus, Key>> = {
  approval: 'status.compact.approval',
  input: 'status.compact.input',
}

/** Primary status dot (null while idle) and its label. */
function statusOf(row: Row, t: Translate): { state: StateDotState; label: string } | null {
  const state = DOT[row.status]
  return state === 'idle' ? null : { state, label: t(`status.${row.status}` as Key) }
}

/** Row label, as in the native list: New session, the stored title, or the localized Untitled. */
export function displayTitle(row: Pick<Row, 'blank' | 'storedTitle'>, t: Translate): string {
  if (row.blank) return t('session.new')
  return row.storedTitle === '' ? t('session.untitled') : row.storedTitle
}

function timeLabel(at: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}` as Key, { n })
}

function agoLabel(at: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now' ? t('time.now') : t('time.ago', { t: t(`time.${unit}` as Key, { n }) })
}

/** Wall-clock time for a Snooze return: time only today, date and time otherwise. */
export function clockLabel(at: number, now: number): string {
  const date = new Date(at)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The task-state line for a parked session (hover card, indicator tooltip), or null. */
export function taskLine(row: Row, t: Translate, now: number): string | null {
  const disposition = row.record?.disposition
  if (row.placement === 'snoozed' && disposition?.kind === 'snoozed') {
    return t('status.snoozedUntil', { time: clockLabel(disposition.until, now) })
  }
  if (row.placement === 'settled' && disposition?.kind === 'settled') {
    if (disposition.reason === 'idle-timeout' && disposition.deadline !== undefined && disposition.anchorAt !== undefined) {
      return t('status.settledAuto', { days: Math.round((disposition.deadline - disposition.anchorAt) / DAY_MS) })
    }
    return t('status.settledManual')
  }
  return null
}

/** The quick task action a row offers in place of the native Archive button. */
export type QuickAction = 'settle' | 'unsettle' | 'unarchive' | null

export function quickActionOf(row: Row): QuickAction {
  if (row.blank) return null
  if (row.native.archived) return 'unarchive'
  if (row.native.pinned) return null
  if (row.placement === 'settled') return 'unsettle'
  // Offer Settle exactly when the command would be accepted for the facts this browser sees.
  return settle(row.record ?? emptyRecord(row.sessionId, 0), row.facts, row.native, 0).ok ? 'settle' : null
}

// ── Title marquee (native behavior: crawl a clipped title while hovered) ─────

const MIN_TITLE_REVEAL_PX = 8
const TITLE_MARQUEE_PX_PER_MS = 0.03

function placeTitle(title: HTMLSpanElement, left: number, range: number): void {
  if (typeof title.scrollTo === 'function') title.scrollTo({ left, behavior: 'instant' })
  else title.scrollLeft = left
  if (left > 0) title.dataset['scrolled'] = ''
  else delete title.dataset['scrolled']
  if (left < range) title.dataset['clipped'] = ''
  else delete title.dataset['clipped']
}

function restTitle(title: HTMLSpanElement): void {
  if (typeof title.scrollTo === 'function') title.scrollTo({ left: 0, behavior: 'instant' })
  else title.scrollLeft = 0
  delete title.dataset['scrolled']
  delete title.dataset['clipped']
}

function useTitleMarquee(title: RefObject<HTMLSpanElement | null>) {
  const frame = useRef(0)
  const revealing = useRef(false)
  useEffect(() => () => { cancelAnimationFrame(frame.current) }, [])
  return useMemo(() => ({
    enter: (event?: PointerEvent): void => {
      if (event?.pointerType === 'touch' || title.current === null || revealing.current) return
      revealing.current = true
      const element = title.current
      const range = element.scrollWidth - element.clientWidth
      if (range <= MIN_TITLE_REVEAL_PX) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        placeTitle(element, range, range)
        return
      }
      cancelAnimationFrame(frame.current)
      let previous: number | undefined
      let position = 0
      const step = (now: DOMHighResTimeStamp): void => {
        position += previous === undefined ? 0 : (now - previous) * TITLE_MARQUEE_PX_PER_MS
        previous = now
        placeTitle(element, Math.min(position, range), range)
        if (position < range) frame.current = requestAnimationFrame(step)
      }
      frame.current = requestAnimationFrame(step)
    },
    leave: (): void => {
      revealing.current = false
      cancelAnimationFrame(frame.current)
      if (title.current !== null) restTitle(title.current)
    },
  }), [title])
}

// ── Session row ──────────────────────────────────────────────────────────────

function SessionHoverContent({ row, env }: { row: Row; env: RowEnv }) {
  const { t, now } = env
  const status = statusOf(row, t)
  const task = taskLine(row, t, now)
  const backend = env.runtime.backend.getSnapshot()
  const held = backend.kind === 'host' && heldResultOf(row, backend.policy) !== null
  return (
    <div className="t3sb-hover-content">
      <div className="t3sb-hover-title">{displayTitle(row, t)}</div>
      {row.cwd !== null && <div className="t3sb-hover-path">{row.cwd}</div>}
      {!row.blank && <div className="t3sb-hover-time">{agoLabel(row.updatedAt, now, t)}</div>}
      {task !== null && <div className="t3sb-hover-task">{task}</div>}
      {row.record?.policyOverride === 'disabled' && !row.native.archived && (
        <div className="t3sb-hover-task">{t('hover.autoSettleOff')}</div>
      )}
      {held && !row.native.archived && row.placement !== 'settled' && <div className="t3sb-hover-task">{t('hover.held')}</div>}
      {status !== null && !row.native.archived && (
        <div className="t3sb-hover-status"><StateDot state={status.state} /><span>{status.label}</span></div>
      )}
      {row.native.archived && (
        <div className="t3sb-hover-status"><IconArchiveOutlineRegular size={14} /><span>{t('row.archived')}</span></div>
      )}
    </div>
  )
}

function QuickActionButton({ row, env }: { row: Row; env: RowEnv }) {
  const { runtime, t } = env
  const action = quickActionOf(row)
  if (action === null) return null
  const name = displayTitle(row, t)
  if (action === 'unarchive') {
    return (
      <Tooltip label={t('actions.unarchive')} side="bottom" align="end" delayMs={500} portal>
        <button type="button" className="t3sb-icon-button" aria-label={t('actions.unarchive.aria')}
          onClick={() => { runtime.unarchive(row.sessionId) }}>
          <IconUnarchiveOutlineRegular size={14} />
        </button>
      </Tooltip>
    )
  }
  const settling = action === 'settle'
  return (
    <Tooltip label={t(settling ? 'actions.settle' : 'actions.unsettle')} side="bottom" align="end" delayMs={500} portal>
      <button type="button" className="t3sb-icon-button" data-action={action} disabled={!env.ready}
        aria-label={t(settling ? 'actions.settle.aria' : 'actions.unsettle.aria', { name })}
        onClick={() => { void runtime.command(row.sessionId, settling ? { kind: 'settle' } : { kind: 'reopen' }) }}>
        {settling ? <IconCheckCircleOutlineRegular size={14} /> : <IconUnarchiveOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}

function PinButton({ row, env }: { row: Row; env: RowEnv }) {
  const { runtime, t } = env
  if (row.native.archived || row.blank) return null
  const pinned = row.native.pinned
  return (
    <Tooltip label={t(pinned ? 'actions.unpin' : 'actions.pin')} side="bottom" align="end" delayMs={500} portal>
      <button type="button" className="t3sb-icon-button" aria-label={t(pinned ? 'actions.unpin.aria' : 'actions.pin.aria')}
        onClick={() => { (pinned ? runtime.unpin : runtime.pin)(row.sessionId) }}>
        {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}

/** The native row's "…" trigger: toggles the shared session menu (which holds Archive). */
function MoreButton({ row, env, title, menuOpen }: { row: Row; env: RowEnv; title: string; menuOpen: boolean }) {
  return (
    <Tooltip label={env.t('actions.session.aria', { name: title })} side="bottom" align="end" delayMs={500} portal>
      <button type="button" className="t3sb-icon-button" aria-label={env.t('actions.session.aria', { name: title })}
        aria-haspopup="menu" aria-expanded={menuOpen} data-context-menu-trigger="" data-action="more"
        onPointerDown={(event) => { event.stopPropagation() }}
        onClick={(event) => {
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          env.runtime.toggleSessionMenu(row.sessionId, row.storedTitle, { x: rect.left, y: rect.bottom })
        }}>
        <IconEllipsisOutlineRegular size={14} />
      </button>
    </Tooltip>
  )
}

export function SessionRow({ row, env, showPin }: { row: Row; env: RowEnv; showPin: boolean }) {
  const { t, now } = env
  const title = displayTitle(row, t)
  const status = statusOf(row, t)
  const compact = COMPACT[row.status]
  const archived = row.native.archived
  const menuOpen = env.menuSessionId === row.sessionId
  const rowRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const marquee = useTitleMarquee(titleRef)
  useEffect(() => {
    if (menuOpen || rowRef.current?.matches(':hover')) marquee.enter()
    else marquee.leave()
  }, [menuOpen, marquee])
  const parked = env.statusGrouping || archived ? null : row.placement === 'snoozed' || row.placement === 'settled' ? row.placement : null
  const parkedLabel = parked === null ? null : taskLine(row, t, now) ?? t(parked === 'snoozed' ? 'section.snoozed' : 'row.settled')
  const openKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    env.open(row)
  }
  // The menu's rename seeds from this field: the stored title the row shows, empty for an Untitled row (never the host's id or directory fallback).
  const target = row.blank ? undefined : { kind: 'session' as const, value: { sessionId: row.sessionId, displayTitle: row.storedTitle } }
  const triggerProps = env.menu?.getTriggerProps(target, { onKeyDown: openKey })
    ?? {
      onKeyDown: openKey,
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        if (target === undefined) return
        event.preventDefault()
        env.runtime.openSessionMenu(row.sessionId, row.storedTitle, { x: event.clientX, y: event.clientY })
      },
    }
  const own = (
    <div
      ref={rowRef}
      data-row-key={`session:${row.sessionId}`}
      data-session-id={row.sessionId}
      data-status={row.status}
      className={cx('t3sb-session-row', row.current && 't3sb-selected', menuOpen && 't3sb-menu-open', archived && 't3sb-archived')}
      role="treeitem"
      aria-selected={row.current}
      aria-description={archived ? t('toast.archivedNotOpenable') : undefined}
      tabIndex={0}
      onClick={() => { env.open(row) }}
      {...triggerProps}
      onPointerEnter={marquee.enter}
      onPointerLeave={() => { if (!menuOpen) marquee.leave() }}
    >
      <span className="t3sb-slot">
        {!archived && !row.blank && status !== null && (
          <>
            <StateDot state={status.state} />
            <span className="t3sb-visually-hidden">{status.label}</span>
          </>
        )}
      </span>
      <span ref={titleRef} className="t3sb-title">{title}</span>
      {!row.blank && (
        <span className="t3sb-row-resting">
          <span className={cx('t3sb-time', compact === undefined && 't3sb-timestamp')} aria-hidden={compact === undefined ? undefined : true}>
            {compact === undefined ? timeLabel(row.updatedAt, now, t) : t(compact)}
          </span>
          {parked !== null && parkedLabel !== null && (
            <span className="t3sb-indicator" role="img" aria-label={parkedLabel} title={parkedLabel}>
              {parked === 'snoozed' ? <IconAlarmClockOutlineRegular size={14} /> : <IconCheckCircleOutlineRegular size={14} />}
            </span>
          )}
          {showPin && row.native.pinned && !archived && (
            <span className="t3sb-indicator" role="img" aria-label={t('row.pinned')} title={t('row.pinned')}>
              <IconPinFillRegular size={14} />
            </span>
          )}
        </span>
      )}
      {!row.blank && (
        <span className="t3sb-row-actions" onClick={(event) => { event.stopPropagation() }}>
          <MoreButton row={row} env={env} title={title} menuOpen={menuOpen} />
          <QuickActionButton row={row} env={env} />
          <PinButton row={row} env={env} />
        </span>
      )}
    </div>
  )
  return (
    <HoverCard
      anchor={own}
      content={<SessionHoverContent row={row} env={env} />}
      openDelayMs={800}
      grouped
      disabled={menuOpen}
      copyText={row.blank || row.storedTitle === '' ? undefined : row.storedTitle}
      copyLabel={t('hover.copy')}
      copiedLabel={t('hover.copied')}
    />
  )
}

// ── Group header row ─────────────────────────────────────────────────────────

export interface GroupAction {
  readonly id: string
  readonly label: string
  readonly icon: ReactNode
  readonly danger?: boolean
  readonly run: () => void
}

/**
 * A group header: the group icon (swapped for the expand arrow on hover), its
 * title, and its count while collapsed; optional hover actions — a menu and a
 * New session button — and an optional hover card.
 */
export function GroupRow(props: {
  rowKey: string
  icon: ReactNode
  title: string
  expanded: boolean
  count: number
  active?: boolean
  onToggle: () => void
  t: Translate
  menu?: readonly GroupAction[]
  onCreate?: () => void
  hover?: ReactNode
  copyText?: string
}) {
  const { t, expanded } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menu = props.menu ?? []
  const own = (
    <div
      className={cx('t3sb-group-row', menuOpen && 't3sb-menu-open')}
      data-row-key={props.rowKey}
      role="treeitem"
      aria-expanded={expanded}
      tabIndex={0}
      onClick={props.onToggle}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ' || (event.key === 'ArrowLeft' && expanded) || (event.key === 'ArrowRight' && !expanded)) {
          event.preventDefault()
          props.onToggle()
        }
      }}
      onContextMenu={menu.length === 0 ? undefined : (event) => { event.preventDefault(); setMenuOpen(true) }}
    >
      <span className={cx('t3sb-slot', 't3sb-group-icon', props.active === true && 't3sb-group-icon-active')}>{props.icon}</span>
      <span className="t3sb-slot t3sb-chevron">
        <IconTriangleRightFillRegular className={cx('t3sb-arrow', expanded && 't3sb-arrow-open')} />
      </span>
      <span className="t3sb-group-text">
        <span className="t3sb-title">{props.title}</span>
        {!expanded && props.count > 0 && <span className="t3sb-group-count" aria-label={t('section.count', { n: props.count })}>{props.count}</span>}
      </span>
      {(menu.length > 0 || props.onCreate !== undefined) && (
        <span className="t3sb-row-actions" onClick={(event) => { event.stopPropagation() }}>
          {menu.length > 0 && (
            <Menu
              open={menuOpen}
              onClose={() => { setMenuOpen(false) }}
              items={menu.map(action => ({ id: action.id, label: action.label, icon: action.icon, danger: action.danger === true }))}
              onSelect={(id) => { setMenuOpen(false); menu.find(action => action.id === id)?.run() }}
              align="start"
              dense
              portal
              anchor={(
                <button ref={buttonRef} type="button" className="t3sb-icon-button" aria-label={t('actions.workspace.aria', { name: props.title })}
                  aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => { setMenuOpen(open => !open) }}>
                  <IconEllipsisOutlineRegular size={14} />
                </button>
              )}
            />
          )}
          {props.onCreate !== undefined && (
            <Tooltip label={t('actions.newSession')} side="bottom" align="end" delayMs={500} portal>
              <button type="button" className="t3sb-icon-button" aria-label={t('actions.newSession.aria', { name: props.title })}
                onClick={() => { props.onCreate?.() }}>
                <IconNewChatOutlineRegular size={14} />
              </button>
            </Tooltip>
          )}
        </span>
      )}
    </div>
  )
  if (props.hover === undefined) return own
  return (
    <HoverCard anchor={own} content={props.hover} openDelayMs={800} grouped disabled={menuOpen}
      copyText={props.copyText} copyLabel={t('hover.copy')} copiedLabel={t('hover.copied')} />
  )
}

export const workspaceMenuIcons = { rename: <IconEditOutlineRegular />, remove: <IconTrashOutlineRegular /> }

export function WorkspaceHoverContent({ title, path, createdAt, t }: { title: string; path: string; createdAt: number | null; t: Translate }) {
  let created: string | null = null
  if (createdAt !== null) {
    const d = new Date(createdAt)
    const pad = (v: number) => String(v).padStart(2, '0')
    created = t('hover.created', { time: `${t('date.ymd', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })} ${pad(d.getHours())}:${pad(d.getMinutes())}` })
  }
  return (
    <div className="t3sb-hover-content">
      <div className="t3sb-hover-title">{title}</div>
      <div className="t3sb-hover-path">{path}</div>
      {created !== null && <div className="t3sb-hover-time">{created}</div>}
    </div>
  )
}

// ── Search result ────────────────────────────────────────────────────────────

export function SearchResultRow({ row, snippet, place, env }: { row: Row; snippet: string | null; place: string; env: RowEnv }) {
  const { t } = env
  const archived = row.native.archived
  const status = statusOf(row, t)
  return (
    <div
      className={cx('t3sb-search-row', row.current && 't3sb-selected', archived && 't3sb-archived')}
      data-session-id={row.sessionId}
      role="treeitem"
      aria-selected={row.current}
      aria-description={archived ? t('toast.archivedNotOpenable') : undefined}
      tabIndex={0}
      onClick={() => { env.open(row) }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); env.open(row) }
      }}
    >
      <span className="t3sb-search-heading">
        <span className="t3sb-slot">
          {!archived && status !== null && <><StateDot state={status.state} /><span className="t3sb-visually-hidden">{status.label}</span></>}
        </span>
        <span className="t3sb-search-title">{displayTitle(row, t)}</span>
        {archived && (
          <span className="t3sb-row-actions">
            <Tooltip label={t('actions.unarchive')} side="bottom" align="end" delayMs={500} portal>
              <button type="button" className="t3sb-icon-button" aria-label={t('actions.unarchive.aria')}
                onClick={(event) => { event.stopPropagation(); env.runtime.unarchive(row.sessionId) }}>
                <IconUnarchiveOutlineRegular size={14} />
              </button>
            </Tooltip>
          </span>
        )}
      </span>
      <span className="t3sb-search-meta">
        <span className="t3sb-search-workspace">{place === '' ? t('group.ungrouped') : place}</span>
        {snippet !== null && <span className="t3sb-search-snippet">{snippet}</span>}
      </span>
    </div>
  )
}
