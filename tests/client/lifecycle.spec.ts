/**
 * Client assembly lifecycle (issue #4 §B), on a real Cordis context: the
 * plugin's `apply` is enabled and disabled repeatedly while the Host connection
 * succeeds, fails in each classified way, or fails after the plugin was
 * unloaded. Every route — Remote mounts, inject scopes, slot and menu
 * registrations, store subscriptions, follow streams, timers — must be released.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import * as client from '../../src/client/index.tsx'
import {
  ConnectAbortedError, connectHostBackend, HostConnectError, type BackendState, type MountCtx, type RemoteResult,
} from '../../src/client/backend.ts'
import type { Snapshot } from '../../src/contracts/schema.ts'
import type { Runtime } from '../../src/client/runtime.ts'
import { createStore, type Readable } from '../../src/client/store.ts'
import { EMPTY_ACTIVITY, emptyRecord } from '../../src/domain/types.ts'
import { baseline, deferred, FakeRemote, flush, POLICY, snapshot, taskView } from './remote-fakes.ts'

const NAMESPACE = 't3Sidebar'

/** A Readable that counts live subscriptions. */
function counted<T>(initial: T) {
  const store = createStore(initial)
  let live = 0
  const readable: Readable<T> & { readonly live: number; set(value: T): void } = {
    getSnapshot: () => store.getSnapshot(),
    subscribe(listener) {
      live += 1
      const stop = store.subscribe(listener)
      let done = false
      return () => { if (!done) { done = true; live -= 1; stop() } }
    },
    set: value => store.set(value),
    get live() { return live },
  }
  return readable
}

interface Env {
  root: Context
  /** The API the next `$mount` exposes (null: the namespace never appears). */
  nextApi: () => FakeRemote | null
  apis: FakeRemote[]
  mounts: number
  unmounts: number
  /** `sidebar.workspaces` registrations. */
  slots: Set<{ inject: () => { runtime: Runtime } }>
  /** Other plugins' `sidebar.workspaces` entries (the native browser, rivals). */
  foreign: { component: unknown; options: { priority?: number }; inject?: () => Record<string, unknown>; registrant?: string }[]
  /** Live `slots.subscribe` listeners. */
  slotListeners: Set<() => void>
  notifySlots(): void
  /** Other slot registrations (the settings page under Plugins). */
  pages: Set<{ name: string; key?: string }>
  menus: Set<unknown>
  locales: number
  status: ReturnType<typeof counted<Map<string, { running?: boolean }>>>
  sessions: ReturnType<typeof counted<{ byId: Record<string, unknown>; items: unknown[] }>>
  workspaces: ReturnType<typeof counted<{ items: unknown[]; pinnedSessionIds: string[]; archivedSessionIds: string[] }>>
  locale: ReturnType<typeof counted<string>>
  access: ReturnType<typeof counted<boolean>>
  replaceNamespace(api: FakeRemote): void
}

let envs: Env[] = []

function createEnv(nextApi: () => FakeRemote | null): Env {
  const root = new Context()
  const env = {
    root, nextApi, apis: [] as FakeRemote[], mounts: 0, unmounts: 0,
    slots: new Set(), pages: new Set(), menus: new Set(), locales: 0, foreign: [], slotListeners: new Set(),
    status: counted(new Map<string, { running?: boolean }>()),
    sessions: counted({ byId: {}, items: [] }),
    workspaces: counted({ items: [], pinnedSessionIds: [], archivedSessionIds: [] }),
    locale: counted('en'),
    access: counted(true),
  } as unknown as Env

  class Slots extends Service {
    constructor(ctx: Context) { super(ctx, 'slots') }
    // Like the real slot service: the registration lives with the caller's fiber.
    inject(_key: string, callback: () => (() => void) | void) {
      this.ctx.effect(() => {
        const dispose = callback()
        return () => { dispose?.() }
      })
    }
    register(options: { name: string; key?: string; inject: () => { runtime: Runtime } }, component?: unknown) {
      const ledger: Set<unknown> = options.name === 'sidebar.workspaces' ? env.slots : env.pages
      const stored = { ...options, component }
      ledger.add(stored)
      env.notifySlots()
      return () => { ledger.delete(stored); env.notifySlots() }
    }
    entries(key: string) {
      if (key !== 'sidebar.workspaces') return []
      return [...env.slots as Set<{ priority?: number; component?: unknown; inject: () => Record<string, unknown> }>]
        .map((entry): Env['foreign'][number] => ({ component: entry.component, options: { priority: entry.priority }, inject: entry.inject }))
        .concat(env.foreign)
        .sort((left, right) => (left.options.priority ?? 0) - (right.options.priority ?? 0))
    }
    subscribe(_key: string, listener: () => void) {
      env.slotListeners.add(listener)
      return () => { env.slotListeners.delete(listener) }
    }
  }
  env.notifySlots = () => { for (const listener of [...env.slotListeners]) listener() }
  root.plugin(Slots)

  // Like the real Remote: one namespace service shared by every mount of it.
  let provided: (() => unknown) | null = null
  let refs = 0
  const remote: Record<string, unknown> & { $mount(info: unknown): Promise<() => void> } = {
    async $mount() {
      env.mounts += 1
      refs += 1
      if (provided === null) {
        const api = env.nextApi()
        if (api !== null) {
          env.apis.push(api)
          remote[NAMESPACE] = api
          provided = root.provide(`remote.${NAMESPACE}`, api)
        }
      }
      let done = false
      return () => {
        if (done) return
        done = true
        env.unmounts += 1
        refs -= 1
        if (refs === 0) {
          delete remote[NAMESPACE]
          provided?.()
          provided = null
        }
      }
    },
  }
  env.replaceNamespace = (api: FakeRemote) => {
    env.apis.push(api)
    remote[NAMESPACE] = api
    provided?.()
    provided = root.provide(`remote.${NAMESPACE}`, api)
  }

  root.provide('sessions', { list: env.sessions, searchResultLimit: 50, search: async () => ({ ok: true, value: { items: [], hasMore: false } }) })
  root.provide('workspaces', { list: env.workspaces, create: async () => {}, rename: async () => {}, delete: async () => {} })
  root.provide('uiWorkspace', { openSession() {}, startSession() {}, unarchiveSession: async () => {}, pickDirectory: async () => null })
  root.provide('uiSession', { sessionStatus: env.status })
  root.provide('contextMenus', {
    open() {},
    register(contribution: unknown) {
      env.menus.add(contribution)
      return () => { env.menus.delete(contribution) }
    },
  })
  root.provide('remote', remote)
  root.provide('remoteAccess', {
    whenAccess(_action: string, start: () => () => void) {
      let stop: (() => void) | undefined
      const sync = () => {
        if (env.access.getSnapshot()) stop ??= start()
        else { stop?.(); stop = undefined }
      }
      const unsubscribe = env.access.subscribe(sync)
      sync()
      return () => { unsubscribe(); stop?.() }
    },
  })
  root.provide('locale', {
    getSnapshot: () => env.locale.getSnapshot(),
    subscribe: (listener: () => void) => env.locale.subscribe(listener),
    register() { env.locales += 1; return () => { env.locales -= 1 } },
    bind: () => (key: string) => key,
  })
  envs.push(env)
  return env
}

const plugin = { name: 'dsh-t3code-sidebar-client', inject: client.inject, apply: client.apply }

const settle = async (ms = 5) => {
  for (let i = 0; i < 4; i++) {
    await flush()
    await new Promise(resolve => setTimeout(resolve, ms))
  }
}

function backendOf(env: Env): BackendState | undefined {
  const [slot] = env.slots
  return slot?.inject().runtime.backend.getSnapshot()
}

/** Live resources this plugin instance holds in the environment. */
function footprint(env: Env) {
  return {
    mounted: env.mounts - env.unmounts,
    slots: env.slots.size,
    pages: env.pages.size,
    menus: env.menus.size,
    locales: env.locales,
    status: env.status.live,
    sessions: env.sessions.live,
    workspaces: env.workspaces.live,
    openStreams: env.apis.flatMap(api => api.streams).filter(stream => !stream.aborted).length,
    slotListeners: env.slotListeners.size,
  }
}

const EMPTY = { mounted: 0, slots: 0, pages: 0, menus: 0, locales: 0, status: 0, sessions: 0, workspaces: 0, openStreams: 0, slotListeners: 0 }

afterEach(async () => {
  vi.useRealTimers()
  for (const env of envs) await (env.root as unknown as { registry: { dispose?: () => unknown } }).registry?.dispose?.()
  envs = []
})

function hostApi(reply?: () => Promise<RemoteResult<Snapshot>>): FakeRemote {
  const api = new FakeRemote()
  if (reply !== undefined) api.snapshotReply = reply
  return api
}

describe('client lifecycle on a real Cordis context', () => {
  it('withdraws the task slot and discards metadata and captured actions when access is revoked', async () => {
    const api = hostApi(async () => ({ ok: true, value: snapshot('e1', 0, [taskView('private', 1, 'settled')]) }))
    const env = createEnv(() => api)
    env.access.set(false)
    const fiber = env.root.plugin(plugin)
    await fiber
    await settle()
    expect(env.slots.size).toBe(0)
    expect(env.mounts).toBe(0)
    env.access.set(true)
    await settle()
    const runtime = [...env.slots][0]!.inject().runtime
    expect(runtime.backend.getSnapshot().tasks.has('private')).toBe(true)

    env.access.set(false)
    await settle()
    expect(runtime.backend.getSnapshot()).toMatchObject({ failure: 'forbidden', tasks: new Map() })
    expect(footprint(env)).toMatchObject({ slots: 0, mounted: 0, openStreams: 0 })
    expect(await runtime.command('private', { kind: 'reopen' })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(api.commands).toHaveLength(0)
    await fiber.dispose()
    expect(env.access.live).toBe(0)
  })

  it('connects to the Host and releases everything on disable, 20 times', async () => {
    const env = createEnv(() => hostApi())
    for (let cycle = 0; cycle < 20; cycle++) {
      const fiber = env.root.plugin(plugin)
      await fiber
      await settle()
      expect(backendOf(env)).toMatchObject({ kind: 'host', status: 'ready' })
      expect(footprint(env)).toMatchObject({ mounted: 1, slots: 1, pages: 1, menus: 1, locales: 1, openStreams: 1, slotListeners: 1 })
      expect([...env.pages]).toEqual([expect.objectContaining({ name: 'plugins.bundle.config', key: 'dsh-t3code-sidebar' })])
      await fiber.dispose()
      await settle()
      expect(footprint(env)).toEqual(EMPTY)
    }
    expect(env.mounts).toBe(20)
  })

  it('falls back to the browser-only preview for an incompatible Host and releases it, 20 times', async () => {
    const env = createEnv(() => hostApi(async () => ({ ok: false, error: { code: 't3Sidebar/protocol-mismatch', message: 'protocol 1 unsupported' } })))
    for (let cycle = 0; cycle < 20; cycle++) {
      const fiber = env.root.plugin(plugin)
      await fiber
      await settle()
      expect(backendOf(env)).toMatchObject({ kind: 'local', failure: 'incompatible' })
      // The wake effect plus the preview's turn observer.
      expect(footprint(env)).toMatchObject({ mounted: 0, status: 2, slots: 1 })
      await fiber.dispose()
      await settle()
      expect(footprint(env)).toEqual(EMPTY)
    }
  })

  it('retries the Host after a transient probe failure instead of switching to the preview, and stops on disable', async () => {
    let failing = true
    const env = createEnv(() => hostApi(async () => {
      if (failing) throw Object.assign(new Error('socket closed'), { code: 'gateway/internal' })
      return { ok: true, value: snapshot('e1', 0) }
    }))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fiber = env.root.plugin(plugin)
    await fiber
    await settle()
    expect(backendOf(env)).toMatchObject({ kind: 'connecting', failure: 'transient' })
    // Only the wake effect observes status: no preview was started.
    expect(footprint(env)).toMatchObject({ mounted: 0, status: 1 })
    failing = false
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(backendOf(env)).toMatchObject({ kind: 'host', status: 'ready' })
    await fiber.dispose()
    await settle()
    expect(footprint(env)).toEqual(EMPTY)

    // Disabled while waiting to retry: the retry never runs.
    failing = true
    const again = env.root.plugin(plugin)
    await again
    await settle()
    const mounts = env.mounts
    await again.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(env.mounts).toBe(mounts)
    expect(footprint(env)).toEqual(EMPTY)
  })

  it('falls back after a mount timeout (Host half missing), 20 times', async () => {
    const env = createEnv(() => null)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    for (let cycle = 0; cycle < 20; cycle++) {
      const fiber = env.root.plugin(plugin)
      await fiber
      await settle()
      expect(backendOf(env)).toMatchObject({ kind: 'connecting' })
      await vi.advanceTimersByTimeAsync(10_000)
      await settle()
      expect(backendOf(env)).toMatchObject({ kind: 'local', failure: 'missing' })
      await fiber.dispose()
      await settle()
      expect(footprint(env)).toEqual(EMPTY)
    }
  }, 30_000)

  it('creates nothing when the probe fails after the plugin was disabled, 20 times', async () => {
    const replies: ReturnType<typeof deferred<RemoteResult<Snapshot>>>[] = []
    const env = createEnv(() => hostApi(() => { const reply = deferred<RemoteResult<Snapshot>>(); replies.push(reply); return reply.promise }))
    for (let cycle = 0; cycle < 20; cycle++) {
      const fiber = env.root.plugin(plugin)
      await fiber
      await settle()
      expect(replies).toHaveLength(cycle + 1)
      await fiber.dispose()
      // The late answer is a definitive failure that would otherwise start the preview.
      replies[cycle]!.resolve({ ok: false, error: { code: 't3Sidebar/protocol-mismatch', message: 'late' } })
      await settle()
      expect(footprint(env)).toEqual(EMPTY)
    }
  })

  it('drops a Host connection that completes after the plugin was disabled', async () => {
    const reply = deferred<RemoteResult<Snapshot>>()
    const env = createEnv(() => hostApi(() => reply.promise))
    const fiber = env.root.plugin(plugin)
    await fiber
    await settle()
    await fiber.dispose()
    reply.resolve({ ok: true, value: snapshot('e1', 0) })
    await settle()
    expect(footprint(env)).toEqual(EMPTY)
    expect(env.apis[0]!.streams).toHaveLength(0)
  })

  it('follows a replaced namespace service and leaves another plugin instance untouched', async () => {
    const env = createEnv(() => hostApi())
    const first = env.root.plugin(plugin)
    const second = env.root.plugin(plugin)
    await first
    await second
    await settle()
    expect(env.slots.size).toBe(2)
    const [slotA, slotB] = [...env.slots]
    const stateA = () => slotA!.inject().runtime.backend.getSnapshot()
    const stateB = () => slotB!.inject().runtime.backend.getSnapshot()
    expect(stateA()).toMatchObject({ kind: 'host', status: 'ready' })
    expect(stateB()).toMatchObject({ kind: 'host', status: 'ready' })

    const replacement = hostApi()
    env.replaceNamespace(replacement)
    await settle()
    expect(replacement.streams).toHaveLength(2) // both instances resubscribed on the new service
    expect(stateA().status).toBe('stale')
    for (const stream of replacement.streams) stream.push(baseline('e2', 0))
    await settle()
    expect(stateA()).toMatchObject({ status: 'ready' })

    await first.dispose()
    await settle()
    expect(env.slots.size).toBe(1)
    expect(stateB()).toMatchObject({ kind: 'host', status: 'ready' })
    expect(replacement.streams.filter(stream => !stream.aborted)).toHaveLength(1)
    // Disabling issues no destructive call: no commands or policy writes.
    expect(env.apis.flatMap(api => [...api.commands, ...api.policies])).toHaveLength(0)
    await second.dispose()
    await settle()
    expect(env.slots.size).toBe(0)
  })
})

describe('connectHostBackend failure paths', () => {
  function mountCtx(api: FakeRemote | null) {
    const counts = { mounts: 0, unmounts: 0, injects: 0, released: 0 }
    const ctx: MountCtx = {
      remote: {
        async $mount() {
          counts.mounts += 1
          return () => { counts.unmounts += 1 }
        },
      },
      inject(_deps, callback) {
        counts.injects += 1
        if (api !== null) queueMicrotask(() => { callback({ remote: { [NAMESPACE]: api } }) })
        // A cordis Fiber: disposed through `.dispose()`, not callable.
        return { dispose: () => { counts.released += 1 } }
      },
    }
    return { ctx, counts }
  }
  const options = { onConnectionReset: () => () => {}, mountTimeoutMs: 20 }

  it('releases the mount and the inject scope when the probe rejects', async () => {
    const api = hostApi(async () => { throw Object.assign(new Error('closed'), { code: 'gateway/internal' }) })
    const { ctx, counts } = mountCtx(api)
    const error = await connectHostBackend(ctx, options).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HostConnectError)
    expect(error).toMatchObject({ failure: 'transient' })
    expect(counts).toEqual({ mounts: 1, unmounts: 1, injects: 1, released: 1 })
  })

  const transport = (status: number) => `client api: t3Sidebar/getSnapshot failed: transport failure for /api/t3Sidebar/getSnapshot: HTTP ${status}`
  it.each([
    ['t3Sidebar/protocol-mismatch', 'no', 'incompatible'],
    ['gateway/bad-request', 'no', 'incompatible'],
    ['gateway/forbidden', 'no', 'forbidden'],
    ['gateway/peer-disposed', 'no', 'forbidden'],
    ['remote-access/denied', 'no', 'forbidden'],
    ['viewer-not-authorized', 'share access ended', 'forbidden'],
    ['share-stopped', 'share access ended', 'forbidden'],
    ['gateway/not-found', 'no', 'missing'],
    ['gateway/internal', 'no', 'transient'],
    // Real dsh 0.2.2-rc.1 Web answers (Host half off → 404).
    ['gateway/internal', transport(404), 'missing'],
    ['gateway/internal', transport(403), 'forbidden'],
    ['gateway/internal', transport(400), 'incompatible'],
    ['gateway/internal', transport(502), 'transient'],
    ['gateway/internal', 'transport failure for /api/t3Sidebar/getSnapshot: Failed to fetch', 'transient'],
  ] as const)('classifies a %s probe answer (%s) as %s and releases everything', async (code, message, failure) => {
    const { ctx, counts } = mountCtx(hostApi(async () => ({ ok: false, error: { code, message } })))
    await expect(connectHostBackend(ctx, options)).rejects.toMatchObject({ failure })
    expect(counts).toEqual({ mounts: 1, unmounts: 1, injects: 1, released: 1 })
  })

  it('reports a missing namespace after the mount timeout and releases everything', async () => {
    const { ctx, counts } = mountCtx(null)
    await expect(connectHostBackend(ctx, options)).rejects.toMatchObject({ failure: 'missing' })
    expect(counts).toEqual({ mounts: 1, unmounts: 1, injects: 1, released: 1 })
  })

  it('aborts while the probe is in flight and still releases everything', async () => {
    const reply = deferred<RemoteResult<Snapshot>>()
    const { ctx, counts } = mountCtx(hostApi(() => reply.promise))
    const abort = new AbortController()
    const pending = connectHostBackend(ctx, { ...options, signal: abort.signal })
    await settle(1)
    abort.abort()
    reply.resolve({ ok: true, value: snapshot('e1', 0) })
    await expect(pending).rejects.toBeInstanceOf(ConnectAbortedError)
    expect(counts).toEqual({ mounts: 1, unmounts: 1, injects: 1, released: 1 })
  })

  it('aborts while waiting for the namespace without waiting for the timeout', async () => {
    const { ctx, counts } = mountCtx(null)
    const abort = new AbortController()
    const pending = connectHostBackend(ctx, { ...options, mountTimeoutMs: 60_000, signal: abort.signal })
    await settle(1)
    abort.abort()
    await expect(pending).rejects.toBeInstanceOf(ConnectAbortedError)
    expect(counts).toEqual({ mounts: 1, unmounts: 1, injects: 1, released: 1 })
  })

  it('a connected backend releases the mount and the inject scope exactly once on dispose', async () => {
    const { ctx, counts } = mountCtx(hostApi())
    const backend = await connectHostBackend(ctx, options)
    expect(counts).toEqual({ mounts: 1, unmounts: 0, injects: 1, released: 0 })
    backend.dispose()
    backend.dispose()
    await settle(1)
    expect(counts).toEqual({ mounts: 1, unmounts: 1, injects: 1, released: 1 })
  })
})

describe('slot registry and session menu on a real Cordis context', () => {
  const runtimeOf = (env: Env): Runtime => [...env.slots][0]!.inject().runtime

  it('bridges the native ⌘K / ⌘O requests, reports a rival winner, and releases its subscriptions', async () => {
    const env = createEnv(() => hostApi())
    const shortcuts = counted({ searchRequest: 0, addRequested: false, directoryBusy: false, renameTarget: null })
    const closeAddWorkspace = vi.fn(() => { shortcuts.set({ ...shortcuts.getSnapshot(), addRequested: false }) })
    env.foreign.push({ component: 'WorkspaceBrowser', options: {}, registrant: 'ui-workspace', inject: () => ({ closeAddWorkspace, hooks: { workspaceShortcuts: shortcuts } }) })
    for (let cycle = 0; cycle < 20; cycle++) {
      const fiber = env.root.plugin(plugin)
      await fiber
      await settle()
      const runtime = runtimeOf(env)
      expect(runtime.slotStatus.getSnapshot()).toEqual({ known: true, active: true, winner: null })
      shortcuts.set({ ...shortcuts.getSnapshot(), searchRequest: cycle + 1, addRequested: true })
      expect(runtime.shortcutRequests.getSnapshot()).toEqual(expect.objectContaining({ searchRequest: cycle + 1, addRequested: true }))
      runtime.closeAddRequest()
      expect(runtime.shortcutRequests.getSnapshot().addRequested).toBe(false)
      env.foreign.push({ component: 'Rival', options: { priority: -20 }, registrant: 'rival-plugin' })
      env.notifySlots()
      expect(runtime.slotStatus.getSnapshot()).toEqual({ known: true, active: false, winner: 'rival-plugin' })
      env.foreign.pop()
      env.notifySlots()
      await fiber.dispose()
      await settle()
      expect(footprint(env)).toEqual(EMPTY)
      expect(shortcuts.live).toBe(0)
    }
    expect(closeAddWorkspace).toHaveBeenCalledTimes(20)
  })

  it('offers "Acknowledge result" for a result a keep protection holds, and sends it as a command', async () => {
    const env = createEnv(() => hostApi(async () => ({
      ok: true,
      value: snapshot('e1', 0, [{
        sessionId: 's1',
        record: { ...emptyRecord('s1', 0), revision: 2, activity: { ...EMPTY_ACTIVITY, lastTurnEnd: { seq: 4, at: 1, reason: 'error' } } },
        activity: [], autoSettleDeadline: null, autoSettleSkip: 'unacknowledged-failure',
      }], { ...POLICY, keepUnacknowledgedFailures: true }),
    })))
    ;(env.sessions as unknown as { set(value: unknown): void }).set({
      ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'one', title: 'one', running: false, blank: false, updatedAt: Date.now() } }, phase: 'ready',
    })
    ;(env.workspaces as unknown as { set(value: unknown): void }).set({ items: [], pinnedSessionIds: [], archivedSessionIds: [], phase: 'ready' })
    const fiber = env.root.plugin(plugin)
    await fiber
    await settle()
    const menu = [...env.menus][0] as { resolve(target: { sessionId: string }): { id: string; run?: () => void }[] }
    const item = menu.resolve({ sessionId: 's1' }).find(entry => entry.id === 'acknowledge')
    expect(item).toBeDefined()
    item!.run!()
    await settle()
    expect(env.apis[0]!.commands.map(entry => entry.input['action'])).toEqual([{ kind: 'acknowledge-result', turnEndSeq: 4 }])
    // Without a keep protection the item is not offered.
    const plain = createEnv(() => hostApi(async () => ({
      ok: true,
      value: snapshot('e1', 0, [{
        sessionId: 's1',
        record: { ...emptyRecord('s1', 0), revision: 2, activity: { ...EMPTY_ACTIVITY, lastTurnEnd: { seq: 4, at: 1, reason: 'error' } } },
        activity: [], autoSettleDeadline: null, autoSettleSkip: null,
      }]),
    })))
    ;(plain.sessions as unknown as { set(value: unknown): void }).set(env.sessions.getSnapshot())
    ;(plain.workspaces as unknown as { set(value: unknown): void }).set(env.workspaces.getSnapshot())
    await plain.root.plugin(plugin)
    await settle()
    const plainMenu = [...plain.menus][0] as { resolve(target: { sessionId: string }): { id: string }[] }
    expect(plainMenu.resolve({ sessionId: 's1' }).map(entry => entry.id)).not.toContain('acknowledge')
    await fiber.dispose()
  })
})
