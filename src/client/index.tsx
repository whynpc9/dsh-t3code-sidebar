/**
 * dsh-t3code-sidebar — browser half.
 *
 * Replaces the `sidebar.workspaces` region (priority below the native
 * browser's default 0) with a task sidebar composed like the native workspace
 * browser, keeps every ui-workspace service, adds task actions to the native
 * session menu, puts its settings on this package's page under Plugins
 * (`plugins.bundle.config`), and mounts the plugin's own Remote namespace.
 * When the Host namespace is unavailable the browser-only backend takes over
 * and the settings page says so.
 */
import './styles.css'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandAction } from '../contracts/schema.ts'
import { snoozePresets } from '../domain/time.ts'
import { known, type NativeState, type TaskFacts } from '../domain/types.ts'
import {
  ConnectAbortedError, connectHostBackend, HostConnectError, initialBackendState, LocalBackend,
  type BackendState, type CommandOutcome, type HostFailure, type RecoveryNotice, type TaskBackend,
} from './backend.ts'
import { SettingsPage } from './components/SettingsPage.tsx'
import { TaskSidebar } from './components/Sidebar.tsx'
import { en, NS, zh, type Key } from './locales.ts'
import { buildRows, pendingOf, type SessionsSnapshot, type StatusSnapshot, type WorkspacesSnapshot } from './model.ts'
import { DEFAULT_PREFS, migratePrefs, type MenuTarget, type Prefs, type Runtime } from './runtime.ts'
import { createStore, type Readable, type Store } from './store.ts'
import { browserObservedWakes, WakeDispatcher } from './wakes.ts'

export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'contextMenus', 'remote', 'locale']

/** Below the native browser (0); configurable through `localStorage` for slot conflicts. */
const SLOT_PRIORITY = -10
const PREFS_KEY = 't3-sidebar:v1:prefs'
/** npm package name: keys this plugin's page under Plugins. */
const PACKAGE_NAME = 'dsh-t3code-sidebar'
/** Backoff for reconnecting to the Host after a transient connection failure. */
const connectRetryDelay = (attempt: number): number => Math.min(30_000, 1000 * 2 ** attempt)

// The Client context is typed structurally: only the members below are used.
interface ClientCtx {
  slots: {
    inject(key: string, callback: () => unknown): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  sessions: { list: Readable<SessionsSnapshot>; searchResultLimit: number; search(query: string, signal: AbortSignal): Promise<{ ok: boolean; value?: { items: { sessionId: string; snippet?: string }[]; hasMore: boolean } }> }
  workspaces: {
    list: Readable<WorkspacesSnapshot>
    create(input: { path: string }): Promise<unknown>
    rename(workspaceId: string, title: string): Promise<unknown>
    delete(workspaceId: string): Promise<unknown>
  }
  uiWorkspace: {
    openSession(id: string): void
    startSession(workspaceId?: string): void
    unarchiveSession(id: string): Promise<void>
    pinSession(id: string): Promise<void>
    unpinSession(id: string): Promise<void>
    pickDirectory(): Promise<string | null>
  }
  contextMenus: {
    open(target: { kind: 'session'; value: { sessionId: string; displayTitle: string } }, point: { x: number; y: number }): void
    register(contribution: Record<string, unknown>): () => void
    /** The open menu's captured target (absent on hosts without it). */
    active?: Readable<MenuTarget | null>
    close?(): void
  }
  remote: { $mount(contribution: unknown): Promise<() => Promise<void> | void>; [key: string]: unknown }
  inject(deps: string[], callback: (scoped: ClientCtx) => void | (() => void)): () => void
  locale: Readable<unknown> & { register(ns: string, dicts: Record<string, Record<string, string>>): () => void; bind(ns: string): (key: string, params?: Record<string, unknown>) => string }
  effect(callback: () => () => void, label?: string): () => void
  on(event: string, listener: () => void): () => void
  get(name: string): unknown
}

function optional<T>(ctx: ClientCtx, name: string): T | undefined {
  try { return ctx.get(name) as T | undefined } catch { return undefined }
}

function loadPrefs(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY)
    return raw ? migratePrefs(JSON.parse(raw)) : DEFAULT_PREFS
  } catch {
    return DEFAULT_PREFS
  }
}

function persistentPrefs(): Store<Prefs> {
  const store = createStore<Prefs>(loadPrefs())
  store.subscribe(() => {
    try { globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(store.getSnapshot())) } catch { /* private mode */ }
  })
  return store
}

/** Re-bind an observable so detached `getSnapshot`/`subscribe` keep their receiver. */
function rebind<T>(source: Readable<T>): Readable<T> {
  return {
    getSnapshot: () => source.getSnapshot(),
    subscribe: listener => source.subscribe(listener),
  }
}

const EMPTY_STATUS: StatusSnapshot = new Map()
const emptyStatus: Readable<StatusSnapshot> = { getSnapshot: () => EMPTY_STATUS, subscribe: () => () => {} }
const noMenu: Readable<MenuTarget | null> = { getSnapshot: () => null, subscribe: () => () => {} }

export function apply(rawCtx: Context): void {
  const ctx = rawCtx as unknown as ClientCtx
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 't3Sidebar: dictionaries')
  const bound = ctx.locale.bind(NS)
  const t = (key: Key, params?: Record<string, unknown>) => bound(key, params)

  const uiSession = optional<{ sessionStatus: Readable<StatusSnapshot> }>(ctx, 'uiSession')
  const status = uiSession === undefined ? emptyStatus : rebind(uiSession.sessionStatus)
  const sessionsList = rebind(ctx.sessions.list)
  const workspacesList = rebind(ctx.workspaces.list)
  const localeSource = rebind(ctx.locale)
  const prefs = persistentPrefs()
  const backendState = createStore<BackendState>(initialBackendState)
  const snoozeRequest = createStore<string | null>(null)
  const notice = createStore<{ text: string; seq: number } | null>(null)
  let noticeSeq = 0
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  const notify = (text: string) => {
    notice.set({ text, seq: ++noticeSeq })
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => notice.set(null), 5000)
  }

  let backend: TaskBackend | null = null

  /** Current browser-side facts for one session (used by commands and the local backend). */
  const liveFacts = (sessionId: string): { facts: TaskFacts; native: NativeState } | null => {
    const sessions = ctx.sessions.list.getSnapshot()
    const session = sessions.byId[sessionId]
    if (session === undefined) return null
    const workspaces = ctx.workspaces.list.getSnapshot()
    const entry = status.getSnapshot().get(sessionId)
    const view = backendState.getSnapshot().tasks.get(sessionId)
    return {
      native: {
        pinned: workspaces.pinnedSessionIds.includes(sessionId),
        archived: workspaces.archivedSessionIds.includes(sessionId),
      },
      facts: {
        running: known(entry?.running ?? session.running),
        pending: known(pendingOf(session, entry)),
        activity: known((view?.activity ?? []).filter(kind => kind !== 'turn').concat((entry?.running ?? session.running) ? ['turn'] : [])),
        summary: view?.record.activity ?? { lastUserInputAt: null, lastTurnStartAt: null, lastTurnStartSeq: null, lastTurnEnd: null },
      },
    }
  }

  const command = async (sessionId: string, action: CommandAction): Promise<CommandOutcome> => {
    const live = liveFacts(sessionId)
    if (backend === null || live === null) {
      return { ok: false, code: 'BASELINE_PENDING', message: 'not connected', task: null }
    }
    const result = await backend.command(sessionId, action, { ...live, observedPending: live.facts.pending.known ? live.facts.pending.value : null })
    if (!result.ok) notify(errorText(result.code))
    return result
  }

  const errorText = (code: string): string => {
    const key = `error.${code}` as Key
    const text = t(key)
    return text === key ? t('error.generic', { code }) : text
  }

  const recoveryText = (notice: RecoveryNotice): string => {
    if (notice.kind === 'policy') return t(`recovery.policy.${notice.outcome}` as Key)
    if (notice.outcome === 'not-applied') return t('recovery.command.not-applied', { reason: errorText(notice.code ?? 'unknown') })
    return t(`recovery.command.${notice.outcome}` as Key)
  }

  const runtime: Runtime = {
    sessions: sessionsList,
    workspaces: workspacesList,
    status,
    backend: backendState,
    prefs,
    locale: localeSource,
    menuTarget: ctx.contextMenus.active === undefined ? noMenu : rebind(ctx.contextMenus.active),
    t,
    searchLimit: ctx.sessions.searchResultLimit,
    open: id => ctx.uiWorkspace.openSession(id),
    startSession: workspaceId => ctx.uiWorkspace.startSession(workspaceId),
    unarchive: (id) => { ctx.uiWorkspace.unarchiveSession(id).catch(() => notify(t('error.generic', { code: 'unarchive' }))) },
    pin: (id) => { ctx.uiWorkspace.pinSession(id).catch(() => notify(t('error.generic', { code: 'pin' }))) },
    unpin: (id) => { ctx.uiWorkspace.unpinSession(id).catch(() => notify(t('error.generic', { code: 'unpin' }))) },
    openSessionMenu: (sessionId, displayTitle, point) => ctx.contextMenus.open({ kind: 'session', value: { sessionId, displayTitle } }, point),
    toggleSessionMenu: (sessionId, displayTitle, point) => {
      const active = ctx.contextMenus.active?.getSnapshot()
      if (active?.kind === 'session' && active.value['sessionId'] === sessionId && ctx.contextMenus.close !== undefined) ctx.contextMenus.close()
      else ctx.contextMenus.open({ kind: 'session', value: { sessionId, displayTitle } }, point)
    },
    command,
    setPolicy: async (days, keepFailures) => backend === null
      ? { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'not connected', policy: backendState.getSnapshot().policy }
      : await backend.setPolicy(days, keepFailures),
    listTransitions: async limit => backend === null ? [] : await backend.listTransitions(limit),
    search: async (query, signal) => {
      const result = await ctx.sessions.search(query, signal)
      if (!result.ok || result.value === undefined) throw new Error('search failed')
      return { items: result.value.items.map(item => ({ sessionId: item.sessionId, snippet: item.snippet })), hasMore: result.value.hasMore }
    },
    createWorkspace: async (path) => { await ctx.workspaces.create({ path }) },
    renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId) },
    pickDirectory: async () => {
      try { return await ctx.uiWorkspace.pickDirectory() } catch { return null }
    },
    settingsAction: () => {
      const navigation = optional<{ openBundle(packageName: string): void }>(ctx, 'pluginNavigation')
      return navigation === undefined ? undefined : () => { navigation.openBundle(PACKAGE_NAME) }
    },
    notify,
    snoozeRequest,
    notice,
  }

  // ── Backend selection: Host namespace first, browser-only preview otherwise ──
  // Each run of this effect owns one connection attempt chain. Everything it
  // creates (Remote mount, inject scope, backend, status subscription, retry
  // timer) is released by its disposer, and work that finishes after the
  // disposer ran (a late connect or failure) creates nothing.
  ctx.effect(() => {
    const owner = new AbortController()
    let release = (): void => {}
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const adopt = (next: TaskBackend, extra: () => void = () => {}) => {
      backend = next
      backendState.set(next.state.getSnapshot())
      const stop = next.state.subscribe(() => backendState.set(next.state.getSnapshot()))
      release = () => { stop(); extra() }
    }

    const startLocal = (failure: HostFailure, reason: string) => {
      console.warn(`[dsh-t3code-sidebar] Host task service ${failure}; using the browser-only preview:`, reason)
      const local = new LocalBackend(reason, liveFacts, undefined, failure)
      // Feed browser-observed turn boundaries to the local backend.
      let previous = new Map<string, boolean>()
      const observe = () => {
        const next = new Map<string, boolean>()
        for (const [id, entry] of status.getSnapshot()) {
          if (entry.running === undefined) continue
          next.set(id, entry.running)
          if (previous.has(id) && previous.get(id) !== entry.running) local.observeTurn(id, entry.running)
        }
        previous = next
      }
      const stop = status.subscribe(observe)
      observe()
      adopt(local, stop)
    }

    const connect = () => {
      retryTimer = undefined
      connectHostBackend(ctx, {
        signal: owner.signal,
        onConnectionReset: listener => ctx.on('connection/reset', listener),
        onRecovery: notice => notify(recoveryText(notice)),
      }).then((host) => {
        if (owner.signal.aborted) { host.dispose(); return }
        adopt(host)
      }, (error: unknown) => {
        if (owner.signal.aborted || error instanceof ConnectAbortedError) return
        const failure: HostFailure = error instanceof HostConnectError ? error.failure : 'transient'
        const reason = error instanceof Error ? error.message : String(error)
        if (failure !== 'transient') { startLocal(failure, reason); return }
        // A disconnect or Host failure is not a missing Host: keep retrying it
        // instead of forking task state into this browser.
        console.warn('[dsh-t3code-sidebar] Host task service unreachable; retrying:', reason)
        backendState.set({ ...initialBackendState, reason, failure })
        retryTimer = setTimeout(connect, connectRetryDelay(attempt++))
      })
    }
    connect()

    return () => {
      owner.abort()
      clearTimeout(retryTimer)
      release()
      release = () => {}
      backend?.dispose()
      backend = null
      backendState.set(initialBackendState)
      clearTimeout(noticeTimer)
    }
  }, 't3Sidebar: task backend')

  // ── Persist Snooze wakes caused by requests only this browser observes ──
  ctx.effect(() => {
    const dispatcher = new WakeDispatcher(async (wake) => {
      const live = liveFacts(wake.sessionId)
      if (backend === null || live === null) {
        return { ok: false, code: 'BASELINE_PENDING', message: 'not connected', task: null }
      }
      return await backend.command(wake.sessionId, { kind: 'reopen' }, {
        ...live, observedPending: live.facts.pending.known ? live.facts.pending.value : null, background: true,
      })
    })
    const check = () => {
      const state = backendState.getSnapshot()
      if (state.kind !== 'host' || state.status !== 'ready' || backend === null) return
      dispatcher.sync(browserObservedWakes(state.tasks, liveFacts, Date.now() + state.clockOffset))
    }
    const stops = [status.subscribe(check), sessionsList.subscribe(check), backendState.subscribe(check)]
    return () => { for (const stop of stops) stop(); dispatcher.dispose() }
  }, 't3Sidebar: browser-observed wakes')

  // ── Slot: replace the session browsing region ────────────────────────────
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    priority: SLOT_PRIORITY,
    inject: () => ({ runtime }),
  }, TaskSidebar))

  // ── Settings: this package's page under Plugins (declared while that page is served) ──
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: PACKAGE_NAME,
    inject: () => ({ runtime }),
  }, SettingsPage))

  // ── Native session menu: task actions (also reachable from conversation headers) ──
  ctx.effect(() => ctx.contextMenus.register({
    id: 't3Sidebar.task',
    target: 'session',
    order: 150,
    resolve: ({ sessionId }: { sessionId: string }) => {
      const state = backendState.getSnapshot()
      if (state.kind === 'connecting') return []
      const now = Date.now() + state.clockOffset
      const rows = buildRows({
        sessions: ctx.sessions.list.getSnapshot(),
        workspaces: ctx.workspaces.list.getSnapshot(),
        status: status.getSnapshot(),
        tasks: state.tasks,
        lastSeen: prefs.getSnapshot().lastSeen,
        now,
      })
      const row = rows.find(candidate => candidate.sessionId === sessionId)
      if (row === undefined || row.native.archived) return []
      // Until a fresh baseline arrives the actions stay visible but disabled
      // (the backend would refuse them anyway).
      const disabled = state.status !== 'ready'
      const run = (action: CommandAction) => () => { void command(sessionId, action) }
      const items: Record<string, unknown>[] = []
      if (row.placement === 'snoozed' || row.placement === 'settled'
        || (row.native.pinned && row.record !== undefined && row.record.disposition.kind !== 'normal')) {
        items.push({
          id: 'reopen',
          label: row.record?.disposition.kind === 'snoozed' ? t('menu.wake') : t('menu.reopen'),
          separatorBefore: true,
          disabled,
          run: run({ kind: 'reopen' }),
        })
      }
      if (!row.native.pinned && row.placement !== 'snoozed') {
        items.push({
          id: 'snooze',
          label: t('menu.snooze'),
          separatorBefore: items.length === 0,
          disabled,
          children: [
            ...snoozePresets(now).map(preset => ({
              id: `snooze.${preset.id}`,
              label: t(`preset.${preset.id}` as Key),
              disabled,
              run: run({ kind: 'snooze', until: preset.until }),
            })),
            { id: 'snooze.custom', label: t('menu.snoozeCustom'), separatorBefore: true, disabled, run: () => { snoozeRequest.set(sessionId) } },
          ],
        })
      }
      if (!row.native.pinned && row.placement !== 'settled') {
        items.push({ id: 'settle', label: t('menu.settle'), disabled, run: run({ kind: 'settle' }) })
      }
      if (state.kind === 'host' && state.policy.autoSettleAfterDays !== null) {
        const overridden = row.record?.policyOverride === 'disabled'
        items.push({
          id: 'auto-settle',
          label: overridden ? t('menu.autoSettleOn') : t('menu.autoSettleOff'),
          disabled,
          run: run({ kind: 'policy-override', override: overridden ? 'inherit' : 'disabled' }),
        })
      }
      return items
    },
  }), 't3Sidebar: session menu')
}
