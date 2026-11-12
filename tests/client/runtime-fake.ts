/** A Runtime made of plain stores for rendering the slot components in tests. */
import { vi } from 'vitest'
import { initialBackendState, type BackendState } from '../../src/client/backend.ts'
import type { SessionRow, SessionsSnapshot, StatusSnapshot, WorkspacesSnapshot } from '../../src/client/model.ts'
import { NO_REQUESTS, type ShortcutRequests, type SlotStatus } from '../../src/client/native-bridge.ts'
import { DEFAULT_PREFS, type Prefs, type Runtime } from '../../src/client/runtime.ts'
import { createStore, type Store } from '../../src/client/store.ts'

export function session(id: string, patch: Partial<SessionRow> = {}): SessionRow {
  return { id, displayTitle: `Title ${id}`, title: `Title ${id}`, running: false, blank: false, updatedAt: Date.now() - 60_000, ...patch }
}

export interface FakeRuntime extends Runtime {
  readonly sessionsStore: Store<SessionsSnapshot>
  readonly workspacesStore: Store<WorkspacesSnapshot>
  readonly backendStore: Store<BackendState>
  readonly slotStore: Store<SlotStatus>
  readonly requestStore: Store<ShortcutRequests>
}

/** `t` echoes the key and its parameters, so assertions do not depend on copy. */
export const echo = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`

export function fakeRuntime(options: {
  sessions?: readonly SessionRow[]
  workspaces?: WorkspacesSnapshot['items']
  backend?: Partial<BackendState>
  prefs?: Partial<Prefs>
  overrides?: Partial<Runtime>
} = {}): FakeRuntime {
  const sessions = options.sessions ?? []
  const sessionsStore = createStore<SessionsSnapshot>({
    ids: sessions.map(entry => entry.id), byId: Object.fromEntries(sessions.map(entry => [entry.id, entry])), phase: 'ready',
  })
  const workspacesStore = createStore<WorkspacesSnapshot>({
    items: options.workspaces ?? [], pinnedSessionIds: [], archivedSessionIds: [], phase: 'ready',
  })
  const backendStore = createStore<BackendState>({ ...initialBackendState, kind: 'host', status: 'ready', ...options.backend })
  const slotStore = createStore<SlotStatus>({ known: true, active: true, winner: null })
  const requestStore = createStore<ShortcutRequests>(NO_REQUESTS)
  const status = createStore<StatusSnapshot>(new Map())
  const locale = createStore<unknown>('en')
  const runtime: FakeRuntime = {
    sessions: sessionsStore,
    workspaces: workspacesStore,
    status,
    backend: backendStore,
    prefs: createStore<Prefs>({ ...DEFAULT_PREFS, ...options.prefs }),
    locale,
    menuTarget: createStore(null),
    t: echo as Runtime['t'],
    searchLimit: 50,
    open: vi.fn(),
    startSession: vi.fn(),
    unarchive: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    openSessionMenu: vi.fn(),
    toggleSessionMenu: vi.fn(),
    command: vi.fn(async () => ({ ok: false as const, code: 'BASELINE_PENDING' as const, message: 'fake', task: null })),
    setPolicy: vi.fn(async () => ({ ok: true as const, policy: backendStore.getSnapshot().policy })),
    listTransitions: vi.fn(async () => []),
    previewPolicy: vi.fn(async () => null),
    search: vi.fn(async () => ({ items: [], hasMore: false })),
    createWorkspace: vi.fn(async () => {}),
    renameWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    pickDirectory: vi.fn(async () => null),
    settingsAction: () => undefined,
    notify: vi.fn(),
    snoozeRequest: createStore<string | null>(null),
    notice: createStore<{ text: string; seq: number } | null>(null),
    slotStatus: slotStore,
    shortcutRequests: requestStore,
    closeAddRequest: vi.fn(() => { requestStore.set({ ...requestStore.getSnapshot(), addRequested: false }) }),
    sessionsStore,
    workspacesStore,
    backendStore,
    slotStore,
    requestStore,
    ...options.overrides,
  }
  return runtime
}
