/**
 * What this plugin reads from the `sidebar.workspaces` slot registry
 * (`ctx.slots.entries` / `ctx.slots.subscribe`, public in ui-slots 0.2.2-rc.1):
 *
 * - Which registration renders (the lowest priority wins). When another
 *   plugin shadows this one, the settings page says so (S01 diagnostics).
 * - The native workspace browser's shortcut requests. ui-workspace keeps its
 *   ⌘K (`session.search`) and ⌘O (`workspace.add`) commands registered, but
 *   their handlers only bump a request store that it hands to its own browser
 *   registration (`inject().hooks.workspaceShortcuts`). While this sidebar wins
 *   the slot that browser is not mounted, so nothing consumed the requests.
 *   The native registration still declares them, so this plugin consumes the
 *   same store the native browser would, and clears the add request the same
 *   way (`closeAddWorkspace`). Without a native registration (or with another
 *   shape) the shortcuts stay inert, exactly as before.
 */
import { createStore, type Readable } from './store.ts'

export interface SlotEntryLike {
  readonly component?: unknown
  readonly options?: { readonly priority?: number | undefined }
  readonly inject?: ((...args: never[]) => Record<string, unknown>) | undefined
  readonly registrant?: string | undefined
}

export interface SlotsLike {
  entries?(key: string): readonly SlotEntryLike[]
  subscribe?(key: string, listener: () => void): () => void
}

export interface ShortcutRequests {
  /** Incremented by every ⌘K; a change means "open and focus search". */
  readonly searchRequest: number
  /** Set by ⌘O; cleared through `closeAdd`. */
  readonly addRequested: boolean
}

export interface SlotStatus {
  /** Whether the registry could be read at all. */
  readonly known: boolean
  /** This plugin's registration is the one that renders. */
  readonly active: boolean
  /** Diagnostics label of the registration that renders instead (when not this plugin). */
  readonly winner: string | null
}

export const NO_REQUESTS: ShortcutRequests = { searchRequest: 0, addRequested: false }
const UNKNOWN_STATUS: SlotStatus = { known: false, active: true, winner: null }

const isReadable = (value: unknown): value is Readable<unknown> =>
  typeof value === 'object' && value !== null
  && typeof (value as Readable<unknown>).getSnapshot === 'function'
  && typeof (value as Readable<unknown>).subscribe === 'function'

const asRequests = (value: unknown): ShortcutRequests | null => {
  if (typeof value !== 'object' || value === null) return null
  const { searchRequest, addRequested } = value as Partial<ShortcutRequests>
  return typeof searchRequest === 'number' && typeof addRequested === 'boolean' ? value as ShortcutRequests : null
}

const priorityOf = (entry: SlotEntryLike): number => entry.options?.priority ?? 0

/** The rendering registration (lowest priority) and whether it is this plugin's. */
export function slotStatusOf(entries: readonly SlotEntryLike[], isOwn: (entry: SlotEntryLike) => boolean): SlotStatus {
  if (entries.length === 0) return { known: true, active: false, winner: null }
  const winner = [...entries].sort((left, right) => priorityOf(left) - priorityOf(right))[0]!
  if (isOwn(winner)) return { known: true, active: true, winner: null }
  return { known: true, active: false, winner: winner.registrant ?? null }
}

export interface NativeShortcuts {
  readonly state: Readable<ShortcutRequests>
  closeAdd(): void
}

/** The native browser's shortcut request store, from its own registration's injected props. */
export function nativeShortcutsOf(entries: readonly SlotEntryLike[], isOwn: (entry: SlotEntryLike) => boolean): NativeShortcuts | null {
  for (const entry of entries) {
    if (isOwn(entry) || entry.inject === undefined) continue
    let injected: Record<string, unknown>
    try {
      injected = (entry.inject as () => Record<string, unknown>)()
    } catch {
      continue
    }
    const store = (injected['hooks'] as Record<string, unknown> | undefined)?.['workspaceShortcuts']
    const closeAdd = injected['closeAddWorkspace']
    if (!isReadable(store) || typeof closeAdd !== 'function' || asRequests(store.getSnapshot()) === null) continue
    const state: Readable<ShortcutRequests> = {
      getSnapshot: () => asRequests(store.getSnapshot()) ?? NO_REQUESTS,
      subscribe: listener => store.subscribe(listener),
    }
    return { state, closeAdd: () => { (closeAdd as () => void)() } }
  }
  return null
}

export interface SlotWatch {
  readonly status: Readable<SlotStatus>
  readonly requests: Readable<ShortcutRequests>
  /** Clear the native add-workspace request after handling it. */
  closeAdd(): void
  dispose(): void
}

/**
 * Follow the `sidebar.workspaces` registrations: recompute the winner and
 * re-find the native request store whenever they change.
 */
export function watchSlot(slots: SlotsLike, key: string, isOwn: (entry: SlotEntryLike) => boolean): SlotWatch {
  const status = createStore<SlotStatus>(UNKNOWN_STATUS)
  const requests = createStore<ShortcutRequests>(NO_REQUESTS)
  let native: NativeShortcuts | null = null
  let stopNative = (): void => {}

  const readEntries = (): readonly SlotEntryLike[] | null => {
    try { return slots.entries?.(key) ?? null } catch { return null }
  }
  const refresh = () => {
    const entries = readEntries()
    if (entries === null) { status.set(UNKNOWN_STATUS); return }
    const next = slotStatusOf(entries, isOwn)
    const current = status.getSnapshot()
    if (next.known !== current.known || next.active !== current.active || next.winner !== current.winner) status.set(next)
    const found = nativeShortcutsOf(entries, isOwn)
    stopNative()
    native = found
    if (found === null) { stopNative = () => {}; requests.set(NO_REQUESTS); return }
    const sync = () => { requests.set(found.state.getSnapshot()) }
    stopNative = found.state.subscribe(sync)
    sync()
  }

  let unsubscribe = (): void => {}
  try { unsubscribe = slots.subscribe?.(key, refresh) ?? (() => {}) } catch { /* registry without subscriptions */ }
  refresh()
  return {
    status,
    requests,
    closeAdd: () => { native?.closeAdd() },
    dispose: () => { unsubscribe(); stopNative(); native = null },
  }
}
