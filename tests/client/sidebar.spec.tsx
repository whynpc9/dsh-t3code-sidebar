// @vitest-environment happy-dom
/**
 * The sidebar component in a DOM: search races (A07), keyboard navigation
 * (A08) and the native ⌘K / ⌘O requests it consumes.
 */
import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TaskSidebar, type SidebarProps } from '../../src/client/components/Sidebar.tsx'
import * as model from '../../src/client/model.ts'
import { taskView } from './remote-fakes.ts'
import { createStore } from '../../src/client/store.ts'
import type { MenuTarget, SearchPage } from '../../src/client/runtime.ts'
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
  vi.restoreAllMocks()
})

function render(runtime: FakeRuntime, props: Omit<SidebarProps, 'runtime'> = {}): HTMLElement {
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

describe('session menu updates', () => {
  it('renders only the old and new targets and still refreshes row labels on locale changes', () => {
    const menuTarget = createStore<MenuTarget | null>(null)
    const locale = createStore('en')
    const runtime = fakeRuntime({
      sessions: ['a', 'b', 'c'].map(id => session(id)),
      overrides: { menuTarget, locale, t: key => `${locale.getSnapshot()}-${key}` },
    })
    const getTriggerProps = vi.fn(() => ({}))
    const bindings = { getTriggerProps }
    const view = render(runtime, { useContextMenu: () => bindings })
    const updateMenu = (id: string | null) => {
      getTriggerProps.mockClear()
      act(() => { menuTarget.set(id === null ? null : { kind: 'session', value: { sessionId: id } }) })
      return view.querySelector('.t3sb-menu-open')?.getAttribute('data-session-id')
    }
    expect(updateMenu('a')).toBe('a')
    expect(getTriggerProps).toHaveBeenCalledTimes(1)
    expect(updateMenu('b')).toBe('b')
    expect(getTriggerProps).toHaveBeenCalledTimes(2)
    expect(updateMenu(null)).toBeUndefined()
    expect(getTriggerProps).toHaveBeenCalledTimes(1)
    act(() => { locale.set('zh') })
    expect(view.querySelector('[data-session-id="c"] [data-action="more"]')?.getAttribute('aria-label')).toBe('zh-actions.session.aria')
  })
})

describe('hidden list views', () => {
  it('keeps rail read markers and workspace selection without joining or grouping session rows', () => {
    const build = vi.spyOn(model, 'buildRows')
    const group = vi.spyOn(model, 'workspaceGroups')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const task = taskView('s1', 1)
    const activity = { ...task.record.activity, lastTurnEnd: { seq: 7, at: 100, reason: 'completed' as const } }
    const runtime = fakeRuntime({
      sessions: [session('child', { origin: 'subagent', retainedBy: { mainView: 1 } }), session('s1', { retainedBy: { mainView: 1 } })],
      workspaces: [{ workspaceId: 'ws', title: 'Test', path: '/test', sessionIds: ['s1'] }],
      backend: { tasks: new Map([['s1', { ...task, record: { ...task.record, activity } }]]) },
      prefs: { groupBy: 'workspace' },
    })
    const view = render(runtime, { wide: false })
    expect(runtime.prefs.getSnapshot()).toMatchObject({ lastSeen: { s1: 7 }, collapsed: { 'workspace:ws': false } })
    expect(build).not.toHaveBeenCalled()
    expect(group).not.toHaveBeenCalled()
    act(() => { root!.render(<TaskSidebar runtime={runtime} wide />) })
    expect(view.querySelector('[data-session-id="s1"]')).not.toBeNull()
    expect(build).toHaveBeenCalledOnce()
    expect(group).toHaveBeenCalledOnce()
    group.mockClear()
    type(searchInput(view), 's1')
    expect(resultIds(view)).toEqual(['s1'])
    expect(group).not.toHaveBeenCalled()
  })
})

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

  it('history search: marks the match, says while the Host is still indexing, and asks again until complete', async () => {
    const pages: SearchPage[] = [
      { items: [], hasMore: false, indexing: { indexed: 3, total: 10 } },
      { items: [{ sessionId: 's2', snippet: 'Fix the <b>Needle</b> bug', highlight: [11, 17] }], hasMore: false },
    ]
    const search = vi.fn(async () => pages.shift() ?? { items: [], hasMore: false })
    const runtime = fakeRuntime({ sessions: [session('s1'), session('s2')], prefs: { historySearch: true }, overrides: { search } })
    const view = render(runtime)
    expect(searchInput(view).placeholder).toBe('search.placeholderHistory')
    type(searchInput(view), 'needle')
    await wait(300)
    // Not "no matches" while sessions are still being read.
    expect(view.querySelector('[data-testid="t3-search-indexing"]')?.textContent).toBe('search.indexing(indexed=3,total=10)')
    expect(view.textContent).not.toContain('search.noMatches')
    await wait(1600)
    expect(search).toHaveBeenCalledTimes(2)
    expect(resultIds(view)).toEqual(['s2'])
    expect(view.querySelector('.t3sb-search-mark')?.textContent).toBe('Needle')
    // Snippet text is rendered as text, never as HTML.
    expect(view.querySelector('.t3sb-search-snippet b')).toBeNull()
    expect(view.querySelector('[data-testid="t3-search-indexing"]')).toBeNull()
  })

  it('history search: stops asking when only unreadable sessions are left', async () => {
    const search = vi.fn(async () => ({ items: [], hasMore: false, indexing: { indexed: 4, total: 4 } }))
    const runtime = fakeRuntime({ sessions: [session('s1')], prefs: { historySearch: true }, overrides: { search } })
    const view = render(runtime)
    type(searchInput(view), 'needle')
    await wait(300)
    expect(view.querySelector('[data-testid="t3-search-indexing"]')?.textContent).toBe('search.partial')
    await wait(1600)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('history search: says when older sessions exceed the Host budget, and does not ask again', async () => {
    const search = vi.fn(async () => ({ items: [], hasMore: false, indexing: { indexed: 4, total: 9, limited: true } }))
    const runtime = fakeRuntime({ sessions: [session('s1')], prefs: { historySearch: true }, overrides: { search } })
    const view = render(runtime)
    type(searchInput(view), 'needle')
    await wait(300)
    expect(view.querySelector('[data-testid="t3-search-indexing"]')?.textContent).toBe('search.limited(indexed=4,total=9)')
    await wait(1600)
    expect(search).toHaveBeenCalledTimes(1)
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
  // Explicit, distinct recency (s1 newest): equal timestamps sort by id, but
  // fixtures stamped across a millisecond tick would reorder the rows.
  const base = Date.now() - 60_000
  const sessions = [session('s1', { updatedAt: base }), session('s2', { updatedAt: base - 1000 }), session('s3', { updatedAt: base - 2000 })]

  it('locates the current session after a search excludes it without reopening the conversation', async () => {
    const runtime = fakeRuntime({ sessions: [session('s1', { retainedBy: { mainView: 1 } }), session('s2')] })
    const view = render(runtime)
    type(searchInput(view), 'Title s2')
    await wait(300)
    expect(resultIds(view)).toEqual(['s2'])
    const locate = [...view.querySelectorAll('button')].find(button => button.textContent === 'locate.action')!
    locate.focus()
    act(() => { locate.click() })
    expect(searchInput(view).value).toBe('')
    expect(focusedKey()).toBe('session:s1')
    expect(runtime.open).not.toHaveBeenCalled()
  })

  it('locates an active session outside an archived-only filter and opens its collapsed workspace', () => {
    const runtime = fakeRuntime({
      sessions: [session('s1', { retainedBy: { mainView: 1 } })],
      workspaces: [{ workspaceId: 'ws', path: '/test', title: 'Test', sessionIds: ['s1'] }],
      prefs: { groupBy: 'workspace', archivedFilter: 'only', collapsed: { 'workspace:ws': true } },
    })
    const view = render(runtime)
    const locate = [...view.querySelectorAll('button')].find(button => button.textContent === 'locate.action')!
    act(() => { locate.click() })
    expect(runtime.prefs.getSnapshot()).toMatchObject({ archivedFilter: 'default', collapsed: { 'workspace:ws': false } })
    expect(focusedKey()).toBe('session:s1')
    expect(view.querySelectorAll('[data-session-id="s1"]')).toHaveLength(1)
  })

  it('returns focus to the session actions after cancelling custom Snooze', async () => {
    const runtime = fakeRuntime({ sessions })
    const view = render(runtime)
    act(() => { runtime.snoozeRequest.set('s2') })
    const cancel = [...view.querySelectorAll('button')].find(button => button.textContent === 'snooze.cancel')!
    act(() => { cancel.click() })
    await wait(40)
    expect(runtime.snoozeRequest.getSnapshot()).toBeNull()
    expect(document.activeElement).toBe(view.querySelector('[data-session-id="s2"] [data-action="more"]'))
    expect(runtime.command).not.toHaveBeenCalled()
  })

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

describe('one-list window (Q02)', () => {
  it('uses the shared Desktop scroll area for windowing and keyboard navigation', () => {
    const sessions = Array.from({ length: 5000 }, (_, i) => session(`s${i}`, { updatedAt: 10000 - i }))
    const runtime = fakeRuntime({ sessions, prefs: { groupBy: 'flat' } })
    const outer = render(runtime, { wide: false })
    outer.style.overflowY = 'auto'
    Object.defineProperty(outer, 'clientHeight', { value: 600 })
    act(() => { root!.render(<TaskSidebar runtime={runtime} />) })

    const list = outer.querySelector<HTMLElement>('.t3sb-flat-list')!
    const trackHeight = sessions.length * 34 - 2 + 16
    Object.defineProperties(list, { scrollHeight: { value: trackHeight }, clientHeight: { value: trackHeight } })
    vi.spyOn(list, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 120 - outer.scrollTop, 280, trackHeight))
    act(() => {
      outer.scrollTop = 3400 + 120
      outer.dispatchEvent(new Event('scroll'))
    })
    const mounted = () => list.querySelectorAll<HTMLElement>('.t3sb-session-row')
    expect(mounted()[0]?.dataset['sessionId']).toBe('s80')
    expect(mounted().length).toBeLessThan(65)
    const row = list.querySelector<HTMLElement>('[data-session-id="s100"]')!
    act(() => { row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(focusedKey()).toBe('session:s4999')
    expect(outer.scrollTop).toBe(120 + 4999 * 34 + 32 - 600)
    expect(list.scrollTop).toBe(0)
    expect(mounted().length).toBeLessThan(65)
  })

  it('skips commits inside the same scroll window and clamps the window when the catalog shrinks', () => {
    const sessions = Array.from({ length: 250 }, (_, i) => session(`s${i}`, { updatedAt: 1000 - i }))
    const runtime = fakeRuntime({ sessions, prefs: { groupBy: 'flat' } })
    const view = render(runtime)
    const onRender = vi.fn()
    act(() => { root!.render(<Profiler id="sidebar" onRender={onRender}><TaskSidebar runtime={runtime} /></Profiler>) })
    const list = view.querySelector<HTMLElement>('.t3sb-flat-list')!
    Object.defineProperty(list, 'clientHeight', { value: 680 })
    const scroll = (top: number) => act(() => {
      list.scrollTop = top
      list.dispatchEvent(new Event('scroll'))
    })
    scroll(3401)
    onRender.mockClear()
    scroll(3402)
    expect(onRender).not.toHaveBeenCalled()
    scroll(3436)
    expect(onRender).toHaveBeenCalled()
    expect(list.querySelector('[data-flat-index="80"]')).toBeNull()
    expect(list.querySelector('[data-flat-index="141"]')).not.toBeNull()
    act(() => { runtime.sessionsStore.set({ ...runtime.sessions.getSnapshot(), ids: ['s0', 's1'] }) })
    expect([...list.querySelectorAll('.t3sb-session-row')].map(row => row.getAttribute('data-session-id'))).toEqual(['s0', 's1'])
  })

  it('replaces the rendered rows as the viewport moves and reaches both ends with the keyboard', () => {
    const now = Date.now()
    const sessions = Array.from({ length: 5000 }, (_, i) => session(`s${i}`, { updatedAt: now - i * 1000 }))
    const view = render(fakeRuntime({ sessions, prefs: { groupBy: 'flat' } }))
    const list = view.querySelector<HTMLElement>('.t3sb-flat-list')!
    Object.defineProperty(list, 'clientHeight', { value: 680 })
    const scroll = (index: number) => {
      act(() => {
        list.scrollTop = index * 34
        list.dispatchEvent(new Event('scroll'))
      })
    }
    const key = (key: string) => act(() => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    const row = (id: number) => list.querySelector<HTMLElement>(`[data-session-id="s${id}"]`)
    scroll(0)
    expect(row(0)).not.toBeNull()
    scroll(2500)
    expect(row(0)).toBeNull()
    expect(row(2500)?.getAttribute('aria-posinset')).toBe('2501')
    expect(row(2500)?.getAttribute('aria-setsize')).toBe('5000')
    expect(list.querySelectorAll('.t3sb-session-row')).toHaveLength(60)
    act(() => { row(2500)?.focus() })
    scroll(3500)
    expect(document.activeElement).toBe(row(2500))
    key('End')
    expect(focusedKey()).toBe('session:s4999')
    expect(row(2500)).toBeNull()
    key('Home')
    expect(focusedKey()).toBe('session:s0')
    key('ArrowDown')
    expect(focusedKey()).toBe('session:s1')
  })

  it('locates and focuses a far current session without opening it or mounting the preceding rows', () => {
    const now = Date.now()
    const sessions = Array.from({ length: 700 }, (_, i) => session(`s${i}`, {
      updatedAt: now - i * 1000,
      ...(i === 450 ? { retainedBy: { mainView: 1 } } : {}),
    }))
    const runtime = fakeRuntime({ sessions, prefs: { groupBy: 'flat' } })
    const view = render(runtime)
    const list = view.querySelector<HTMLElement>('.t3sb-flat-list')!
    Object.defineProperty(list, 'clientHeight', { value: 680 })
    expect(view.querySelector('[aria-selected="true"]')).toBeNull()
    act(() => { view.querySelector<HTMLButtonElement>('.t3sb-locate button')?.click() })
    expect(focusedKey()).toBe('session:s450')
    expect(view.querySelector('[data-session-id="s0"]')).toBeNull()
    expect(view.querySelectorAll('.t3sb-session-row').length).toBeLessThan(65)
    expect(runtime.open).not.toHaveBeenCalled()
  })
})
