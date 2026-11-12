import { describe, expect, it, vi } from 'vitest'
import { nativeShortcutsOf, slotStatusOf, watchSlot, type SlotEntryLike } from '../../src/client/native-bridge.ts'
import { createStore } from '../../src/client/store.ts'

const OWN = Symbol('own')
const isOwn = (entry: SlotEntryLike) => entry.component === OWN

function nativeEntry() {
  const state = createStore({ searchRequest: 0, addRequested: false, directoryBusy: false, renameTarget: null })
  const closeAddWorkspace = vi.fn(() => { state.set({ ...state.getSnapshot(), addRequested: false }) })
  const entry: SlotEntryLike = {
    component: 'WorkspaceBrowser',
    options: {},
    registrant: 'ui-workspace',
    inject: () => ({ closeAddWorkspace, hooks: { workspaceShortcuts: state } }),
  }
  return { entry, state, closeAddWorkspace }
}

function fakeSlots(entries: SlotEntryLike[]) {
  const listeners = new Set<() => void>()
  return {
    entries: vi.fn(() => entries),
    subscribe: vi.fn((_key: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    change(next: SlotEntryLike[]) { entries.splice(0, entries.length, ...next); for (const listener of [...listeners]) listener() },
    listeners,
  }
}

describe('slotStatusOf', () => {
  it('names the lowest-priority registration as the one that renders', () => {
    const own: SlotEntryLike = { component: OWN, options: { priority: -10 } }
    const native: SlotEntryLike = { component: 'native', options: {} }
    const rival: SlotEntryLike = { component: 'rival', options: { priority: -20 }, registrant: 'other-plugin' }
    expect(slotStatusOf([native, own], isOwn)).toEqual({ known: true, active: true, winner: null })
    expect(slotStatusOf([native, own, rival], isOwn)).toEqual({ known: true, active: false, winner: 'other-plugin' })
    expect(slotStatusOf([], isOwn)).toEqual({ known: true, active: false, winner: null })
  })
})

describe('nativeShortcutsOf', () => {
  it('finds the request store the native browser registration declares', () => {
    const { entry, state } = nativeEntry()
    const found = nativeShortcutsOf([{ component: OWN }, entry], isOwn)
    expect(found?.state.getSnapshot()).toEqual({ searchRequest: 0, addRequested: false, directoryBusy: false, renameTarget: null })
    state.set({ ...state.getSnapshot(), searchRequest: 1 })
    expect(found?.state.getSnapshot().searchRequest).toBe(1)
  })

  it('ignores registrations of another shape or whose inject throws', () => {
    expect(nativeShortcutsOf([{ component: 'x', inject: () => ({ hooks: {} }) }], isOwn)).toBeNull()
    expect(nativeShortcutsOf([{ component: 'x', inject: () => { throw new Error('needs args') } }], isOwn)).toBeNull()
    expect(nativeShortcutsOf([{ component: 'x', inject: () => ({ closeAddWorkspace: () => {}, hooks: { workspaceShortcuts: createStore({ other: 1 }) } }) }], isOwn)).toBeNull()
  })
})

describe('watchSlot', () => {
  it('follows registration changes and the native requests, and releases everything on dispose', () => {
    const native = nativeEntry()
    const slots = fakeSlots([{ component: OWN, options: { priority: -10 } }])
    const watch = watchSlot(slots, 'sidebar.workspaces', isOwn)
    expect(watch.status.getSnapshot()).toMatchObject({ active: true })
    expect(watch.requests.getSnapshot()).toEqual({ searchRequest: 0, addRequested: false })

    // The native browser registers later (load order is not guaranteed).
    slots.change([{ component: OWN, options: { priority: -10 } }, native.entry])
    native.state.set({ ...native.state.getSnapshot(), searchRequest: 1 })
    expect(watch.requests.getSnapshot().searchRequest).toBe(1)
    native.state.set({ ...native.state.getSnapshot(), addRequested: true })
    expect(watch.requests.getSnapshot().addRequested).toBe(true)
    watch.closeAdd()
    expect(native.closeAddWorkspace).toHaveBeenCalledOnce()
    expect(watch.requests.getSnapshot().addRequested).toBe(false)

    // A rival plugin shadows this one.
    slots.change([{ component: OWN, options: { priority: -10 } }, native.entry, { component: 'rival', options: { priority: -20 }, registrant: 'rival' }])
    expect(watch.status.getSnapshot()).toEqual({ known: true, active: false, winner: 'rival' })

    watch.dispose()
    expect(slots.listeners.size).toBe(0)
    native.state.set({ ...native.state.getSnapshot(), searchRequest: 9 })
    expect(watch.requests.getSnapshot().searchRequest).toBe(1)
  })

  it('stays inert on a registry without entries or subscriptions', () => {
    const watch = watchSlot({}, 'sidebar.workspaces', isOwn)
    expect(watch.status.getSnapshot()).toEqual({ known: false, active: true, winner: null })
    expect(() => { watch.closeAdd(); watch.dispose() }).not.toThrow()
  })
})
