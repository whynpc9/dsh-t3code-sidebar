import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { nextFocusIndex, type Row } from '../model.ts'
import { SessionRow, type RowEnv } from './Rows.tsx'

const ROW_HEIGHT = 32
const ROW_STRIDE = ROW_HEIGHT + 2
const OVERSCAN = 20

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
  const list = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [keyboardTarget, setKeyboardTarget] = useState<string | null>(null)

  const readViewport = (element: HTMLDivElement) => {
    const { scrollTop: top, clientHeight: height } = element
    setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height })
  }

  useLayoutEffect(() => {
    const element = list.current
    if (element === null) return
    const measure = () => { readViewport(element) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // Clamp when rows disappear while scrolled deep into the list.
  const height = Math.max(0, rows.length * ROW_STRIDE - 2)
  const top = Math.min(viewport.top, Math.max(0, height + 16 - viewport.height))
  const first = Math.floor(top / ROW_STRIDE)
  const afterLast = Math.ceil((top + Math.max(viewport.height, ROW_STRIDE)) / ROW_STRIDE)
  const start = Math.max(0, first - OVERSCAN)
  const end = Math.min(rows.length, afterLast + OVERSCAN)

  const rowIndex = (id: string | null | undefined) => id == null ? -1 : rows.findIndex(row => row.sessionId === id)
  const currentIndex = rowIndex(currentId)
  const targetId = locateTarget ?? keyboardTarget
  const targetIndex = rowIndex(targetId)
  // Keep interactive rows keyed and mounted if the user scrolls with focus, a menu or a dialog open.
  const retained = new Set([targetIndex, rowIndex(focusedId), rowIndex(env.menuSessionId), rowIndex(snoozeTarget ?? snoozeFocusTarget)])
  const indices = [...retained].filter(index => index >= 0 && (index < start || index >= end))
  for (let index = start; index < end; index += 1) indices.push(index)
  indices.sort((a, b) => a - b)

  useLayoutEffect(() => {
    const element = list.current
    if (targetId === null || element === null) return
    if (targetIndex >= 0) {
      const rowTop = targetIndex * ROW_STRIDE
      const rowBottom = rowTop + ROW_HEIGHT
      if (rowTop < element.scrollTop) element.scrollTop = rowTop
      else if (rowBottom > element.scrollTop + element.clientHeight) {
        element.scrollTop = rowBottom - element.clientHeight
      }
      readViewport(element)
      element.querySelector<HTMLElement>(`[data-flat-index="${targetIndex}"] .t3sb-session-row`)?.focus({ preventScroll: true })
    }
    if (locateTarget !== null) onLocated()
    setKeyboardTarget(null)
  }, [targetId, targetIndex, locateTarget, onLocated])

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
                  <SessionRow row={row} env={env} showPin position={{ index: index + 1, count: rows.length }} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
