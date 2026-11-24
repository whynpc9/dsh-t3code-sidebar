import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { nextFocusIndex, type Row } from '../model.ts'
import { SessionRow, useSessionMenuId, type RowEnv } from './Rows.tsx'

const ROW_HEIGHT = 32
const ROW_STRIDE = ROW_HEIGHT + 2
const OVERSCAN = 20

// Some Desktop versions scroll all sidebar sections together. The list in that
// layout grows to its track height, so its own clientHeight is not the viewport.
function outerScrollArea(list: HTMLElement): HTMLElement | null {
  for (let parent = list.parentElement; parent !== null; parent = parent.parentElement) {
    if (['auto', 'scroll', 'overlay'].includes(getComputedStyle(parent).overflowY)) return parent
  }
  return null
}

function listViewport(list: HTMLElement, outer: HTMLElement | null) {
  if (outer === null || list.scrollHeight > list.clientHeight) {
    return { scroller: list, top: list.scrollTop, height: list.clientHeight }
  }
  const top = outer.getBoundingClientRect().top + outer.clientTop - list.getBoundingClientRect().top - list.clientTop
  return { scroller: outer, top, height: outer.clientHeight }
}

/** Fixed-height rows keep the full scroll range while mounting only a viewport and its neighbors. */
export function FlatSessionList({ rows, env, label, currentId, locateNotice, empty, locateTarget, onLocated, snoozeTarget, snoozeFocusTarget }: {
  rows: readonly Row[]
  env: RowEnv
  label: string
  currentId: string | undefined
  locateNotice: ReactNode
  empty: ReactNode
  locateTarget: string | null
  onLocated: () => void
  snoozeTarget: string | null
  snoozeFocusTarget: string | null
}) {
  const menuId = useSessionMenuId(env.runtime)
  const list = useRef<HTMLDivElement>(null)
  const outer = useRef<HTMLElement | null>(null)
  const count = rows.length
  const height = Math.max(0, count * ROW_STRIDE - 2)
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(count, 1 + OVERSCAN) }))
  const lastRange = useRef(range)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [keyboardTarget, setKeyboardTarget] = useState<string | null>(null)

  const readViewport = useCallback((element: HTMLDivElement) => {
    const viewport = listViewport(element, outer.current)
    const viewportHeight = viewport.height
    // The list includes 16px of bottom padding. Clamp on shrink, even before a scroll event arrives.
    const top = Math.min(viewport.top, Math.max(0, height + 16 - viewportHeight))
    const start = Math.max(0, Math.floor(top / ROW_STRIDE) - OVERSCAN)
    const end = Math.max(0, Math.min(count, Math.ceil((top + Math.max(viewportHeight, ROW_STRIDE)) / ROW_STRIDE) + OVERSCAN))
    if (start === lastRange.current.start && end === lastRange.current.end) return
    const next = { start, end }
    lastRange.current = next
    setRange(next)
  }, [count, height])

  useLayoutEffect(() => {
    const element = list.current
    if (element === null) return
    const parent = outerScrollArea(element)
    outer.current = parent
    const measure = () => { readViewport(element) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (parent !== null) {
      observer.observe(parent)
      parent.addEventListener('scroll', measure, { passive: true })
    }
    return () => {
      observer.disconnect()
      parent?.removeEventListener('scroll', measure)
    }
  }, [readViewport])

  const start = range.start
  const end = Math.min(range.end, count)
  const rowIndex = (id: string | null | undefined) => id == null ? -1 : rows.findIndex(row => row.sessionId === id)
  const currentIndex = rowIndex(currentId)
  const targetId = locateTarget ?? keyboardTarget
  const targetIndex = rowIndex(targetId)
  // Keep interactive rows keyed and mounted if the user scrolls with focus, a menu or a dialog open.
  const retained = new Set([targetIndex, rowIndex(focusedId), rowIndex(menuId), rowIndex(snoozeTarget ?? snoozeFocusTarget)])
  const indices = [...retained].filter(index => index >= 0 && (index < start || index >= end))
  for (let index = start; index < end; index += 1) indices.push(index)
  indices.sort((a, b) => a - b)

  useLayoutEffect(() => {
    const element = list.current
    if (targetId === null || element === null) return
    if (targetIndex >= 0) {
      const rowTop = targetIndex * ROW_STRIDE
      const rowBottom = rowTop + ROW_HEIGHT
      const viewport = listViewport(element, outer.current)
      if (rowTop < viewport.top) viewport.scroller.scrollTop += rowTop - viewport.top
      else if (rowBottom > viewport.top + viewport.height) {
        viewport.scroller.scrollTop += rowBottom - viewport.top - viewport.height
      }
      readViewport(element)
      element.querySelector<HTMLElement>(`[data-flat-index="${targetIndex}"] .t3sb-session-row`)?.focus({ preventScroll: true })
    }
    if (locateTarget !== null) onLocated()
    setKeyboardTarget(null)
  }, [targetId, targetIndex, locateTarget, onLocated, readViewport])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const row = event.target
    if (!(row instanceof HTMLElement) || !row.matches('.t3sb-session-row')) return
    const index = Number(row.closest<HTMLElement>('[data-flat-index]')?.dataset['flatIndex'])
    const next = nextFocusIndex(event.key, index, rows.length)
    if (next === null) return
    event.preventDefault()
    setKeyboardTarget(rows[next]!.sessionId)
  }

  const showLocate = currentId !== undefined && (currentIndex < start || currentIndex >= end)
  return (
    <>
      {showLocate && locateNotice}
      <div ref={list} className="t3sb-list t3sb-flat-list" role="tree" aria-label={label}
        onKeyDown={onKeyDown} onScroll={event => { readViewport(event.currentTarget) }}
        onFocus={event => { setFocusedId(event.target.closest<HTMLElement>('.t3sb-session-row')?.dataset['sessionId'] ?? null) }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null) }}>
        {rows.length === 0 ? empty : (
          <div className="t3sb-flat-track" role="presentation" style={{ height }}>
            {indices.map(index => {
              const row = rows[index]!
              return (
                <div key={row.sessionId} className="t3sb-flat-item" role="presentation" data-flat-index={index} style={{ top: index * ROW_STRIDE }}>
                  <SessionRow row={row} env={env} showPin menuOpen={row.sessionId === menuId} position={index + 1} count={rows.length} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
