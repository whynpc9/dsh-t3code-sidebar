// @vitest-environment happy-dom
/**
 * The sidebar component in a DOM: search races (A07), keyboard navigation
 * (A08) and the native ⌘K / ⌘O requests it consumes.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TaskSidebar } from '../../src/client/components/Sidebar.tsx'
import type { SearchPage } from '../../src/client/runtime.ts'
import { fakeRuntime, session, type FakeRuntime } from './runtime-fake.ts'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

function render(runtime: FakeRuntime, props: { wide?: boolean; expandSidebar?: () => void } = {}): HTMLElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root!.render(<TaskSidebar runtime={runtime} {...props} />) })
  return container
}

const wait = (ms: number) => act(() => new Promise<void>(resolve => { setTimeout(resolve, ms) }))

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

const searchInput = (view: HTMLElement) => view.querySelector<HTMLInputElement>('.t3sb-search-input')!
const resultIds = (view: HTMLElement) => [...view.querySelectorAll('.t3sb-search-row')].map(row => row.getAttribute('data-session-id'))
const focusedKey = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-row-key') ?? null

describe('search (A07)', () => {
  it('debounces, aborts the superseded request and drops its late answer', async () => {
    const calls: { query: string; signal: AbortSignal; reply: ReturnType<typeof deferred<SearchPage>> }[] = []
    const runtime = fakeRuntime({
      sessions: [session('s1', { displayTitle: 'zz one', title: 'zz one' }), session('s2', { displayTitle: 'zz two', title: 'zz two' })],
      overrides: {
        search: vi.fn((query: string, signal: AbortSignal) => {
          const reply = deferred<SearchPage>()
          calls.push({ query, signal, reply })
          return reply.promise
        }),
      },
    })
    const view = render(runtime)
    type(searchInput(view), 'al')
    type(searchInput(view), 'alpha')
    await wait(300)
    expect(calls.map(call => call.query)).toEqual(['alpha']) // one request per settled query
    type(searchInput(view), 'beta')
    expect(calls[0]!.signal.aborted).toBe(true)
    await wait(300)
    expect(calls.map(call => call.query)).toEqual(['alpha', 'beta'])
    await act(async () => { calls[1]!.reply.resolve({ items: [{ sessionId: 's2', snippet: 'beta body' }], hasMore: false }) })
    await act(async () => { calls[0]!.reply.resolve({ items: [{ sessionId: 's1', snippet: 'alpha body' }], hasMore: false }) })
    expect(resultIds(view)).toEqual(['s2'])
    expect(view.textContent).toContain('beta body')
    expect(view.textContent).not.toContain('alpha body')
  })

  it('shows the pending state, then the capped-results notice, and keeps title matches on failure', async () => {
    const reply = deferred<SearchPage>()
    const runtime = fakeRuntime({
      sessions: [session('s1', { displayTitle: 'needle here', title: 'needle here' }), session('s2')],
      overrides: { search: vi.fn(() => reply.promise) },
    })
    const view = render(runtime)
    type(searchInput(view), 'needle')
    expect(resultIds(view)).toEqual(['s1']) // title match is immediate
    expect(view.querySelector('[role="status"][aria-label="search.pending"]')).not.toBeNull()
    await wait(300)
    await act(async () => { reply.resolve({ items: [{ sessionId: 's2', snippet: 'needle in body' }], hasMore: true }) })
    expect(resultIds(view).sort()).toEqual(['s1', 's2'])
    expect(view.textContent).toContain('search.hasMore(n=50)')
    expect(view.querySelector('[aria-label="search.pending"]')).toBeNull()
  })

  it('keeps instant title matches when the content search fails, and clearing restores the list', async () => {
    const runtime = fakeRuntime({
      sessions: [session('s1', { displayTitle: 'needle', title: 'needle' })],
      overrides: { search: vi.fn(async () => { throw new Error('offline') }) },
    })
    const view = render(runtime)
    type(searchInput(view), 'needle')
    await wait(300)
    expect(resultIds(view)).toEqual(['s1'])
    act(() => { searchInput(view).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(searchInput(view).value).toBe('')
    expect(view.querySelector('.t3sb-search-tree')).toBeNull()
  })

  it('a late answer for a cleared query never brings results back', async () => {
    const reply = deferred<SearchPage>()
    const runtime = fakeRuntime({ sessions: [session('s1')], overrides: { search: vi.fn(() => reply.promise) } })
    const view = render(runtime)
    type(searchInput(view), 'zzz')
    await wait(300)
    type(searchInput(view), '')
    await act(async () => { reply.resolve({ items: [{ sessionId: 's1', snippet: 'late' }], hasMore: false }) })
    expect(view.querySelector('.t3sb-search-tree')).toBeNull()
    expect(view.textContent).not.toContain('late')
  })
})

describe('keyboard navigation (A08)', () => {
  const sessions = [session('s1'), session('s2'), session('s3')]

  it('moves between group headers and rows with the arrow keys, Home and End', () => {
    const runtime = fakeRuntime({ sessions })
    const view = render(runtime)
    const first = view.querySelector<HTMLElement>('[data-row-key="group:status:active"]')!
    first.focus()
    const press = (key: string) => act(() => {
      ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
    press('ArrowDown')
    expect(focusedKey()).toBe('session:s1')
    press('ArrowDown')
    expect(focusedKey()).toBe('session:s2')
    press('End')
    expect(focusedKey()).toBe('session:s3')
    press('ArrowUp')
    expect(focusedKey()).toBe('session:s2')
    press('Home')
    expect(focusedKey()).toBe('group:status:active')
  })

  it('collapses and expands a section with Left / Right and opens a session with Enter', () => {
    const runtime = fakeRuntime({ sessions })
    const view = render(runtime)
    const group = view.querySelector<HTMLElement>('[data-row-key="group:status:active"]')!
    group.focus()
    act(() => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(runtime.prefs.getSnapshot().collapsed['status:active']).toBe(true)
    expect(view.querySelector('[data-row-key="session:s1"]')).toBeNull()
    act(() => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(runtime.prefs.getSnapshot().collapsed['status:active']).toBe(false)
    const row = view.querySelector<HTMLElement>('[data-row-key="session:s2"]')!
    row.focus()
    act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(runtime.open).toHaveBeenCalledWith('s2')
  })

  it('ignores modified arrow keys so Harness shortcuts keep working', () => {
    const runtime = fakeRuntime({ sessions })
    const view = render(runtime)
    const row = view.querySelector<HTMLElement>('[data-row-key="session:s1"]')!
    row.focus()
    act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })) })
    expect(focusedKey()).toBe('session:s1')
  })
})

describe('native ⌘K / ⌘O requests', () => {
  it('opens and focuses search on a new search request, not on the count it mounted with', () => {
    const runtime = fakeRuntime({ sessions: [session('s1')] })
    runtime.requestStore.set({ searchRequest: 3, addRequested: false })
    const view = render(runtime)
    expect(view.querySelector('.t3sb-search-expanded')).toBeNull()
    act(() => { runtime.requestStore.set({ searchRequest: 4, addRequested: false }) })
    expect(view.querySelector('.t3sb-search-expanded')).not.toBeNull()
    expect(document.activeElement).toBe(searchInput(view))
  })

  it('expands the rail before focusing search when the sidebar is collapsed', () => {
    const expandSidebar = vi.fn()
    const runtime = fakeRuntime({ sessions: [session('s1')] })
    render(runtime, { wide: false, expandSidebar })
    act(() => { runtime.requestStore.set({ searchRequest: 1, addRequested: false }) })
    expect(expandSidebar).toHaveBeenCalledOnce()
  })

  it('opens the add-workspace dialog on an add request and clears the request', () => {
    const runtime = fakeRuntime({ sessions: [session('s1')] })
    const view = render(runtime)
    act(() => { runtime.requestStore.set({ searchRequest: 0, addRequested: true }) })
    expect(runtime.closeAddRequest).toHaveBeenCalledOnce()
    expect(runtime.requestStore.getSnapshot().addRequested).toBe(false)
    // The add-workspace dialog is up (its Browse… button comes from the dialog body).
    expect(view.textContent).toContain('workspace.browse')
  })
})
