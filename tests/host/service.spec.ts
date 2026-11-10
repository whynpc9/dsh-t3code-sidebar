import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { durablePendingOf, nearestSnoozeDeadline, sweepDelay, T3SidebarService, unknownRetryDelay } from '../../src/host/service.ts'
import { emptyRecord, type TaskRecord } from '../../src/domain/types.ts'
import type { CommandInput, FollowEvent } from '../../src/contracts/schema.ts'
import { appendStored, createFakeHost, MemoryDomainFacility, type FakeHost, type StoredLog } from './fake-host.ts'

const HOUR = 3_600_000
let hosts: FakeHost[] = []

async function boot(
  storage?: MemoryDomainFacility, revisions: Record<string, string> = {}, createdAt = Date.now() - 1000,
  setup?: (host: FakeHost) => void,
) {
  const host = createFakeHost(storage)
  host.headers.push(
    { id: 's1', createdAt, revision: revisions.s1 },
    { id: 's2', createdAt, revision: revisions.s2 },
    { id: 'child', createdAt: 0, origin: 'subagent' },
  )
  setup?.(host)
  await (host.ctx as Context).plugin(T3SidebarService)
  const service = await new Promise<T3SidebarService>((resolve) => {
    const poll = () => { const s = (host.ctx as unknown as { get(n: string): unknown }).get('t3Sidebar') as T3SidebarService | undefined; if (s) resolve(s); else setTimeout(poll, 5) }
    poll()
  })
  await service.ready
  hosts.push(host)
  return { host, service }
}

const command = (patch: Partial<CommandInput> & Pick<CommandInput, 'action'>): CommandInput => ({
  protocolVersion: 1, commandId: `cmd-${Math.random().toString(36).slice(2)}`, sessionId: 's1', expectedRevision: 0, observedPending: [], ...patch,
})

afterEach(async () => {
  for (const host of hosts) await (host.ctx as unknown as { registry: { dispose?: () => unknown } }).registry?.dispose?.()
  hosts = []
})

describe('T3SidebarService', () => {
  it('starts with an installation id, the default 7-day policy and full Host capabilities', async () => {
    const { service } = await boot()
    const snapshot = service.getSnapshot(1)
    expect(snapshot.installationId).not.toBe('')
    expect(snapshot.policy).toMatchObject({ autoSettleAfterDays: 7 })
    expect(snapshot.capabilities.hostActivity).toBe(true)
    expect(() => service.getSnapshot(2)).toThrow(/protocol/)
  })

  it('applies a snooze, rejects a stale revision and replays a retried command id', async () => {
    const { service } = await boot()
    const input = command({ action: { kind: 'snooze', until: Date.now() + HOUR } })
    const first = await service.command(input)
    expect(first).toMatchObject({ ok: true, replayed: false, task: { record: { revision: 1, disposition: { kind: 'snoozed' } } } })
    const retry = await service.command(input)
    expect(retry).toMatchObject({ ok: true, replayed: true, task: { record: { revision: 1 } } })
    const reused = await service.command({ ...input, action: { kind: 'settle' } })
    expect(reused).toMatchObject({ ok: false, code: 'CONFLICT' })
    const stale = await service.command(command({ action: { kind: 'reopen' }, expectedRevision: 0 }))
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT', task: { record: { revision: 1 } } })
  })

  it('keeps a committed task when bookkeeping fails and re-publishes it on replay', async () => {
    const storage = new MemoryDomainFacility()
    const { service } = await boot(storage)
    const controller = new AbortController()
    const iterator = service.follow(1, controller.signal)[Symbol.asyncIterator]()
    await iterator.next() // baseline
    storage.failGlobalWrites = true
    const input = command({ action: { kind: 'snooze', until: Date.now() + HOUR } })
    const result = await service.command(input)
    expect(result).toMatchObject({ ok: true, task: { record: { disposition: { kind: 'snoozed' } } } })
    expect((await iterator.next()).value).toMatchObject({ kind: 'delta', tasks: [{ sessionId: 's1' }] })
    storage.failGlobalWrites = false
    expect(await service.command(input)).toMatchObject({ ok: true, replayed: true })
    expect((await iterator.next()).value).toMatchObject({ kind: 'delta', tasks: [{ sessionId: 's1', record: { revision: 1 } }] })
    controller.abort()
  })

  it('validates input on the Host and refuses unknown sessions and pinned sessions', async () => {
    const { service, host } = await boot()
    expect(await service.command({ nonsense: true })).toMatchObject({ ok: false, code: 'PROTOCOL_MISMATCH' })
    expect(await service.command(command({ sessionId: 'nope', action: { kind: 'settle' } }))).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    host.registry.pinnedSessionIds.push('s1')
    expect(await service.command(command({ action: { kind: 'snooze', until: Date.now() + HOUR } }))).toMatchObject({ ok: false, code: 'PINNED' })
  })

  it('refuses to settle while Host activity reports work, and accepts once idle', async () => {
    const { service, host } = await boot()
    host.activity.set('s1', ['subagent'])
    expect(await service.command(command({ action: { kind: 'settle' } }))).toMatchObject({ ok: false, code: 'SESSION_ACTIVE' })
    host.activity.set('s1', [])
    expect(await service.command(command({ action: { kind: 'settle' } }))).toMatchObject({ ok: true, task: { record: { disposition: { kind: 'settled', reason: 'manual' } } } })
    expect(service.listTransitions(10)).toMatchObject([{ from: 'normal', to: 'settled', reason: 'manual:settle' }])
  })

  it('treats an empty browser observation as a lower bound when the durable read fails', async () => {
    const { service, host } = await boot()
    host.projectionsFail = true
    expect(await service.command(command({ action: { kind: 'settle' }, observedPending: [] })))
      .toMatchObject({ ok: false, code: 'BASELINE_PENDING' })
    expect(await service.command(command({ action: { kind: 'settle' }, observedPending: [{ source: 'live', key: 'q', kind: 'user-question' }] })))
      .toMatchObject({ ok: false, code: 'PENDING_INPUT' })
    host.projectionsFail = false
    expect(await service.command(command({ action: { kind: 'settle' }, observedPending: [] }))).toMatchObject({ ok: true })
  })

  it('does not apply a command whose write fails (persist before publish)', async () => {
    const storage = new MemoryDomainFacility()
    const { service } = await boot(storage)
    storage.failWrites = true
    const result = await service.command(command({ action: { kind: 'snooze', until: Date.now() + HOUR } }))
    expect(result).toMatchObject({ ok: false, code: 'STORAGE_UNAVAILABLE' })
    storage.failWrites = false
    expect(service.getSnapshot(1).tasks).toHaveLength(0)
  })

  it('follow sends a baseline then contiguous deltas', async () => {
    const { service } = await boot()
    const controller = new AbortController()
    const iterator = service.follow(1, controller.signal)[Symbol.asyncIterator]()
    const baseline = (await iterator.next()).value as FollowEvent
    expect(baseline.kind).toBe('baseline')
    await service.command(command({ action: { kind: 'snooze', until: Date.now() + HOUR } }))
    const delta = (await iterator.next()).value as FollowEvent
    expect(delta).toMatchObject({ kind: 'delta', tasks: [{ sessionId: 's1', record: { disposition: { kind: 'snoozed' } } }] })
    if (baseline.kind === 'baseline' && delta.kind === 'delta') expect(delta.streamSeq).toBe(baseline.snapshot.streamSeq + 1)
    controller.abort()
    expect((await iterator.next()).done).toBe(true)
  })

  it('setPolicy is revision-checked and re-enabling starts a fresh grace window', async () => {
    const { service } = await boot()
    const off = await service.setPolicy({ protocolVersion: 1, expectedRevision: 0, autoSettleAfterDays: null, keepUnacknowledgedFailures: false })
    expect(off).toMatchObject({ ok: true, policy: { revision: 1, autoSettleAfterDays: null } })
    const stale = await service.setPolicy({ protocolVersion: 1, expectedRevision: 0, autoSettleAfterDays: 3, keepUnacknowledgedFailures: false })
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' })
    const on = await service.setPolicy({ protocolVersion: 1, expectedRevision: 1, autoSettleAfterDays: 3, keepUnacknowledgedFailures: true })
    expect(on).toMatchObject({ ok: true, policy: { revision: 2, autoSettleAfterDays: 3 } })
  })

  it('folds committed session events and reopens a settled task on new input', async () => {
    const { service, host } = await boot()
    await service.command(command({ action: { kind: 'settle' } }))
    const session = { id: 's1' }
    const emit = (type: string, seq: number, data: unknown) =>
      (host.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('session/event', session, { type, seq, time: Date.now(), data })
    emit('user/message', 10, { role: 'user', source: { kind: 'user' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    const task = service.getSnapshot(1).tasks.find(entry => entry.sessionId === 's1')!
    expect(task.record.activity.lastUserInputAt).not.toBeNull()
    expect(task.record.disposition.kind).toBe('normal')
  })

  it('records survive a restart of the service over the same storage', async () => {
    const storage = new MemoryDomainFacility()
    const first = await boot(storage)
    await first.service.command(command({ action: { kind: 'snooze', until: Date.now() + HOUR } }))
    const second = await boot(storage)
    expect(second.service.getSnapshot(1).tasks).toMatchObject([{ sessionId: 's1', record: { disposition: { kind: 'snoozed' } } }])
    expect(second.service.getSnapshot(1).installationId).toBe(first.service.getSnapshot(1).installationId)
  })

  it('restarts the idle window of sessions that changed while the plugin was not running', async () => {
    const storage = new MemoryDomainFacility()
    await boot(storage, { s1: 'r1', s2: 'r1' })
    // Installed long ago, so the restarted window is distinguishable from it.
    ;(storage.data.get('t3_sidebar')!.global as { policyEligibleSince: number }).policyEligibleSince = 1
    const reenabledAt = Date.now()
    const second = await boot(storage, { s1: 'r2', s2: 'r1' })
    const tasks = second.service.getSnapshot(1).tasks
    expect(tasks.find(task => task.sessionId === 's1')?.record.policyEligibleSince).toBeGreaterThanOrEqual(reenabledAt)
    expect(tasks.find(task => task.sessionId === 's2')).toBeUndefined()
  })

  it('surfaces Settled and Snoozed tasks whose session changed while the plugin was away', async () => {
    const storage = new MemoryDomainFacility()
    const logs = new Map<string, StoredLog>()
    const first = await boot(storage, { s1: 'r1', s2: 'r1' }, undefined, host => { host.logs = logs })
    await first.service.command(command({ sessionId: 's1', action: { kind: 'settle' } }))
    await first.service.command(command({ sessionId: 's2', action: { kind: 'snooze', until: Date.now() + HOUR } }))
    // While the plugin is away: new human input in s1, a failed turn in s2.
    appendStored(first.host, 's1', 'user/message', { source: { kind: 'user' } })
    appendStored(first.host, 's2', 'turn/start', { turn: 1 })
    appendStored(first.host, 's2', 'turn/end', { turn: 1, reason: { kind: 'error' } })
    const second = await boot(storage, { s1: 'r2', s2: 'r2' }, undefined, host => { host.logs = logs })
    const tasks = second.service.getSnapshot(1).tasks
    expect(tasks.find(task => task.sessionId === 's1')?.record.disposition.kind).toBe('normal')
    expect(tasks.find(task => task.sessionId === 's2')?.record).toMatchObject({ disposition: { kind: 'normal' } })
    expect(tasks.find(task => task.sessionId === 's2')?.record.lastSnoozeWakeAt).not.toBeNull()
    expect(second.service.listTransitions(10).filter(entry => entry.reason === 'missed-activity')).toHaveLength(2)
  })

  it('samples activity at startup so sessions with background work are published as working', async () => {
    const host = createFakeHost()
    host.headers.push({ id: 's1', createdAt: Date.now() - 1000 }, { id: 's2', createdAt: Date.now() - 1000 })
    host.activity.set('s2', ['job'])
    await (host.ctx as Context).plugin(T3SidebarService)
    hosts.push(host)
    const service = await new Promise<T3SidebarService>((resolve) => {
      const poll = () => { const s = (host.ctx as unknown as { get(n: string): unknown }).get('t3Sidebar') as T3SidebarService | undefined; if (s) resolve(s); else setTimeout(poll, 5) }
      poll()
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(service.getSnapshot(1).tasks).toMatchObject([{ sessionId: 's2', activity: ['job'], record: { revision: 0 } }])
    // The implicit revision-0 record accepts commands.
    host.activity.set('s2', [])
    expect(await service.command(command({ sessionId: 's2', action: { kind: 'settle' } }))).toMatchObject({ ok: true })
  })

  it('retries a failed activity answer on a later sweep instead of dropping the session', async () => {
    const { service, host } = await boot()
    host.activity.set('s1', ['job'])
    await service.command(command({ action: { kind: 'reopen' } }))
    expect(service.getSnapshot(1).tasks[0]?.activity).toEqual(['job'])
    const cache = (service as unknown as { activityCache: Map<string, { value: unknown; at: number; failures: number }> }).activityCache
    cache.set('s1', { value: { known: false }, at: Date.now() - 2 * 60_000, failures: 1 })
    expect(service.getSnapshot(1).tasks[0]?.activity).toBeNull()
    await (service as unknown as { sweep(): Promise<void> }).sweep()
    expect(service.getSnapshot(1).tasks[0]?.activity).toEqual(['job'])
  })

  it('does not auto-settle an overdue session whose timed question outlived its turn', async () => {
    const storage = new MemoryDomainFacility()
    const { service, host } = await boot(storage, {}, Date.now() - 30 * 24 * HOUR)
    const global = storage.data.get('t3_sidebar')!.global as { policyEligibleSince: number; installedAt: number }
    global.policyEligibleSince = 1
    global.installedAt = 1
    host.questions.set('s1', [{ callId: 'call-1', state: 'continued' }])
    await (service as unknown as { sweep(): Promise<void> }).sweep()
    const settledIds = () => service.getSnapshot(1).tasks.filter(task => task.record.disposition.kind === 'settled').map(task => task.sessionId)
    expect(settledIds()).toEqual(['s2'])
    host.questions.delete('s1')
    await (service as unknown as { sweep(): Promise<void> }).sweep()
    expect(settledIds().sort()).toEqual(['s1', 's2'])
  })

  it('gives a long-idle session restored from the archive a fresh grace window instead of settling it', async () => {
    const storage = new MemoryDomainFacility()
    const { service, host } = await boot(storage, {}, Date.now() - 30 * 24 * HOUR)
    const global = storage.data.get('t3_sidebar')!.global as { policyEligibleSince: number; installedAt: number }
    global.policyEligibleSince = 1
    global.installedAt = 1
    host.registry.archivedSessionIds.push('s1', 's2')
    const sweep = () => (service as unknown as { sweep(): Promise<void> }).sweep()
    await sweep() // archived: skipped, and remembered as archived
    expect(service.getSnapshot(1).tasks.filter(task => task.record.disposition.kind === 'settled')).toHaveLength(0)
    const restoredAt = Date.now()
    host.registry.archivedSessionIds.splice(0) // both restored
    await sweep()
    const tasks = service.getSnapshot(1).tasks
    expect(tasks.filter(task => task.record.disposition.kind === 'settled')).toHaveLength(0)
    expect(tasks.map(task => task.record.policyEligibleSince >= restoredAt)).toEqual([true, true])
    expect(service.listTransitions(10)).toHaveLength(0) // grace reset is not a placement change
  })

  it('treats ordinary live progress as observed, not as missed activity', async () => {
    const { service, host } = await boot(undefined, { s1: 'r1', s2: 'r1' })
    await service.command(command({ action: { kind: 'snooze', until: Date.now() + HOUR } }))
    const emit = (type: string, seq: number) =>
      (host.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('session/event', { id: 's1' }, { type, seq, time: Date.now(), data: {} })
    const refresh = () => (service as unknown as { refreshHeaders(): Promise<void> }).refreshHeaders()
    emit('step/start', 50) // not folded into the summary, but changes the persistence token
    host.headers[0]!.revision = 'r2'
    await refresh()
    emit('assistant/message', 51)
    host.headers[0]!.revision = 'r3'
    await refresh()
    await refresh() // no new events, token unchanged
    expect(service.getSnapshot(1).tasks.find(task => task.sessionId === 's1')?.record.disposition.kind).toBe('snoozed')
  })

  it('counts events that commit while the persistence listing runs as observed', async () => {
    const { service, host } = await boot(undefined, { s1: 'r1', s2: 'r1' })
    await service.command(command({ action: { kind: 'snooze', until: Date.now() + HOUR } }))
    host.duringList = () => {
      ;(host.ctx as unknown as { emit(name: string, ...args: unknown[]): void })
        .emit('session/event', { id: 's1' }, { type: 'step/start', seq: 70, time: Date.now(), data: {} })
      host.headers[0]!.revision = 'r2'
      host.duringList = null
    }
    await (service as unknown as { refreshHeaders(): Promise<void> }).refreshHeaders()
    expect(service.getSnapshot(1).tasks.find(task => task.sessionId === 's1')?.record.disposition.kind).toBe('snoozed')
  })

  it('backs off a Snooze expiry whose write fails instead of retrying it every sweep', async () => {
    const storage = new MemoryDomainFacility()
    const { service } = await boot(storage)
    await service.command(command({ action: { kind: 'snooze', until: Date.now() + 40 } }))
    storage.failTableWrites = true
    // The service's own deadline timer attempts the expiry and fails.
    await new Promise(resolve => setTimeout(resolve, 120))
    const sweep = () => (service as unknown as { sweep(): Promise<void> }).sweep()
    const retry = (service as unknown as { expiryRetry: Map<string, { failures: number; at: number }> }).expiryRetry.get('s1')
    expect(retry?.failures).toBe(1)
    expect(retry!.at - Date.now()).toBeGreaterThan(50_000)
    await sweep() // within the backoff: not attempted again
    expect((service as unknown as { expiryRetry: Map<string, { failures: number }> }).expiryRetry.get('s1')?.failures).toBe(1)
    storage.failTableWrites = false
  })

  it('recovers a settled task whose new-input fold could not be persisted', async () => {
    const storage = new MemoryDomainFacility()
    const { service, host } = await boot(storage, { s1: 'r1', s2: 'r1' })
    await service.command(command({ action: { kind: 'settle' } }))
    storage.failTableWrites = true
    // Persisted by the Host, but the plugin's fold of it cannot be saved.
    const input = appendStored(host, 's1', 'user/message', { source: { kind: 'user' } })
    ;(host.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('session/event', { id: 's1' }, input)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(service.getSnapshot(1).tasks.find(task => task.sessionId === 's1')?.record.disposition.kind).toBe('settled')
    storage.failTableWrites = false
    host.headers[0]!.revision = 'r2'
    await (service as unknown as { refreshHeaders(): Promise<void> }).refreshHeaders()
    expect(service.getSnapshot(1).tasks.find(task => task.sessionId === 's1')?.record.disposition.kind).toBe('normal')
  })

  it('retries a missed-activity catch-up whose task write failed', async () => {
    const storage = new MemoryDomainFacility()
    const logs = new Map<string, StoredLog>()
    const first = await boot(storage, { s1: 'r1', s2: 'r1' }, undefined, host => { host.logs = logs })
    await first.service.command(command({ sessionId: 's1', action: { kind: 'settle' } }))
    appendStored(first.host, 's1', 'user/message', { source: { kind: 'user' } })
    storage.failTableWrites = true
    const second = await boot(storage, { s1: 'r2', s2: 'r1' }, undefined, host => { host.logs = logs })
    expect(second.service.getSnapshot(1).tasks.find(task => task.sessionId === 's1')?.record.disposition.kind).toBe('settled')
    storage.failTableWrites = false
    const third = await boot(storage, { s1: 'r2', s2: 'r1' }, undefined, host => { host.logs = logs })
    expect(third.service.getSnapshot(1).tasks.find(task => task.sessionId === 's1')?.record.disposition.kind).toBe('normal')
  })

  it('re-samples outstanding background activity on the sweep and publishes the change', async () => {
    const { service, host } = await boot()
    host.activity.set('s1', ['subagent'])
    await service.command(command({ action: { kind: 'reopen' } }))
    expect(service.getSnapshot(1).tasks[0]?.activity).toEqual(['subagent'])
    host.activity.set('s1', [])
    await (service as unknown as { sweep(): Promise<void> }).sweep()
    expect(service.getSnapshot(1).tasks[0]?.activity).toEqual([])
  })
})

describe('missed-activity verification after a restart (#2)', () => {
  type Internals = {
    refreshHeaders(): Promise<void>
    sweep(): Promise<void>
    unverified: Map<string, { token: string; failures: number; at: number }>
  }
  const internals = (service: T3SidebarService) => service as unknown as Internals
  const kindOf = (service: T3SidebarService, id: string) =>
    service.getSnapshot(1).tasks.find(task => task.sessionId === id)?.record.disposition.kind
  const revisionOf = (service: T3SidebarService, id: string) =>
    service.getSnapshot(1).tasks.find(task => task.sessionId === id)?.record.revision ?? 0
  const missed = (service: T3SidebarService) => service.listTransitions(100).filter(entry => entry.reason === 'missed-activity')
  const seenRevisions = (storage: MemoryDomainFacility) =>
    (storage.data.get('t3_sidebar')!.global as { seenRevisions: Record<string, string> }).seenRevisions
  const settle = async (service: T3SidebarService, sessionId: string) =>
    expect(await service.command(command({ sessionId, expectedRevision: revisionOf(service, sessionId), action: { kind: 'settle' } })))
      .toMatchObject({ ok: true })
  const snoozeFor = async (service: T3SidebarService, sessionId: string, ms: number) =>
    expect(await service.command(command({ sessionId, expectedRevision: revisionOf(service, sessionId), action: { kind: 'snooze', until: Date.now() + ms } })))
      .toMatchObject({ ok: true })
  const quit = async (host: FakeHost) => {
    await (host.ctx as unknown as { registry: { dispose?: () => unknown } }).registry?.dispose?.()
    hosts = hosts.filter(entry => entry !== host)
  }
  const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  it('keeps sessions created and parked before their first header refresh parked across a restart', async () => {
    const storage = new MemoryDomainFacility()
    const logs = new Map<string, StoredLog>()
    const first = await boot(storage, { s1: 'r1', s2: 'r1' }, undefined, host => { host.logs = logs })
    await tick(2)
    const createdAt = Date.now()
    const fresh = [{ id: 'n1', createdAt, revision: 'n1-a' }, { id: 'n2', createdAt, revision: 'n2-a' }]
    first.host.headers.push(...fresh)
    // Live events: committed by the Host (stored) and observed by the plugin.
    const live = (id: string, type: string, data: unknown) => {
      const event = appendStored(first.host, id, type, data)
      ;(first.host.ctx as unknown as { emit(name: string, ...args: unknown[]): void })
        .emit('session/event', { id, header: { id, createdAt } }, event)
    }
    live('n1', 'user/message', { source: { kind: 'user' } })
    live('n1', 'turn/start', { turn: 1 })
    live('n1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    live('n2', 'user/message', { source: { kind: 'user' } })
    live('n2', 'turn/start', { turn: 1 })
    live('n2', 'turn/end', { turn: 1, reason: { kind: 'error' } })
    await tick(30)
    await snoozeFor(first.service, 'n1', HOUR)
    await settle(first.service, 'n2')
    expect(await first.service.command(command({ sessionId: 'n2', expectedRevision: revisionOf(first.service, 'n2'), action: { kind: 'reopen' } })))
      .toMatchObject({ ok: true })
    await settle(first.service, 'n2')
    // Title events observed live after parking, then ⌘Q before the ten-minute refresh.
    live('n1', 'session/title', { title: 'one' })
    live('n2', 'session/title', { title: 'two' })
    await tick(10)
    expect(seenRevisions(storage)).not.toHaveProperty('n1')
    await quit(first.host)

    const second = await boot(storage, { s1: 'r1', s2: 'r1' }, undefined, (host) => {
      host.logs = logs
      host.headers.push({ ...fresh[0]!, revision: 'n1-b' }, { ...fresh[1]!, revision: 'n2-b' })
    })
    expect(kindOf(second.service, 'n1')).toBe('snoozed')
    expect(kindOf(second.service, 'n2')).toBe('settled')
    expect(missed(second.service)).toHaveLength(0)
    expect(second.host.opened.sort()).toEqual(['n1', 'n2'])
    // Verified: the tokens are acknowledged, so the next refresh replays nothing.
    expect(seenRevisions(storage)).toMatchObject({ n1: '"n1-b"', n2: '"n2-b"' })
    await internals(second.service).refreshHeaders()
    expect(second.host.opened).toHaveLength(2)
  })

  it('keeps registered sessions parked when only a title or file metadata changed', async () => {
    const storage = new MemoryDomainFacility()
    const logs = new Map<string, StoredLog>()
    const first = await boot(storage, { s1: 'r1', s2: 'r1' }, undefined, host => { host.logs = logs })
    // History from before the plugin was installed; the summary never folded it.
    appendStored(first.host, 's1', 'user/message', { source: { kind: 'user' } }, Date.now() - HOUR)
    appendStored(first.host, 's1', 'turn/start', { turn: 1 }, Date.now() - HOUR)
    await settle(first.service, 's1')
    await snoozeFor(first.service, 's2', HOUR)
    appendStored(first.host, 's1', 'session/title', { title: 'renamed' }) // title only
    await quit(first.host)
    // s2: same log, new token (e.g. a chmod changed ctimeNs).
    const second = await boot(storage, { s1: 'r2', s2: 'r2' }, undefined, host => { host.logs = logs })
    expect(kindOf(second.service, 's1')).toBe('settled')
    expect(kindOf(second.service, 's2')).toBe('snoozed')
    expect(missed(second.service)).toHaveLength(0)
    expect(seenRevisions(storage)).toMatchObject({ s1: '"r2"', s2: '"r2"' })
  })

  it('wakes a parked session exactly once when a persisted event after the park meets the wake rules', async () => {
    const storage = new MemoryDomainFacility()
    const logs = new Map<string, StoredLog>()
    const first = await boot(storage, { s1: 'r1', s2: 'r1' }, undefined, host => { host.logs = logs })
    await settle(first.service, 's1')
    await snoozeFor(first.service, 's2', HOUR)
    await quit(first.host)
    appendStored(first.host, 's1', 'user/message', { source: { kind: 'user' } })
    appendStored(first.host, 's2', 'turn/start', { turn: 1 })
    appendStored(first.host, 's2', 'turn/end', { turn: 1, reason: { kind: 'error' } })
    const second = await boot(storage, { s1: 'r2', s2: 'r2' }, undefined, host => { host.logs = logs })
    expect(kindOf(second.service, 's1')).toBe('normal')
    expect(kindOf(second.service, 's2')).toBe('normal')
    const tasks = second.service.getSnapshot(1).tasks
    expect(tasks.find(task => task.sessionId === 's1')?.record.activity.lastUserInputAt).not.toBeNull()
    expect(tasks.find(task => task.sessionId === 's2')?.record.activity.lastTurnEnd).toMatchObject({ reason: 'error' })
    expect(missed(second.service)).toHaveLength(2)
    await internals(second.service).refreshHeaders()
    await internals(second.service).sweep()
    const third = await boot(storage, { s1: 'r2', s2: 'r2' }, undefined, host => { host.logs = logs })
    expect(missed(third.service)).toHaveLength(2)
  })

  it('still expires a due Snooze at startup and retries a failed replay without waking early', async () => {
    const storage = new MemoryDomainFacility()
    const logs = new Map<string, StoredLog>()
    const first = await boot(storage, { s1: 'r1', s2: 'r1' }, undefined, host => { host.logs = logs })
    await snoozeFor(first.service, 's1', 30)
    await settle(first.service, 's2')
    await quit(first.host)
    appendStored(first.host, 's2', 'user/message', { source: { kind: 'user' } })
    await tick(50)
    const second = await boot(storage, { s1: 'r2', s2: 'r2' }, undefined, (host) => { host.logs = logs; host.replayFail = true })
    await internals(second.service).sweep()
    expect(kindOf(second.service, 's1')).toBe('normal')
    expect(second.service.listTransitions(10).filter(entry => entry.sessionId === 's1' && entry.from === 'snoozed')).toMatchObject([{ reason: 'snooze-expired' }])
    // s2's log cannot be read: it stays settled and is retried with backoff.
    expect(kindOf(second.service, 's2')).toBe('settled')
    const retry = internals(second.service).unverified.get('s2')
    expect(retry?.failures).toBe(1)
    expect(retry!.at - Date.now()).toBeGreaterThan(50_000)
    expect(seenRevisions(storage).s2).toBe('"r1"')
    const opens = second.host.opened.length
    await internals(second.service).sweep() // within the backoff
    expect(second.host.opened).toHaveLength(opens)
    expect(kindOf(second.service, 's2')).toBe('settled')
    // A failed pending read alone cannot rule a wake out either.
    second.host.replayFail = false
    second.host.projectionsFail = true
    internals(second.service).unverified.set('s2', { ...retry!, at: 0 })
    logs.get('s2')!.events.pop()
    await internals(second.service).sweep()
    expect(kindOf(second.service, 's2')).toBe('settled')
    expect(internals(second.service).unverified.get('s2')?.failures).toBe(2)
    // Once both reads succeed, the retry applies the real wake.
    second.host.projectionsFail = false
    appendStored(second.host, 's2', 'user/message', { source: { kind: 'user' } })
    internals(second.service).unverified.set('s2', { ...internals(second.service).unverified.get('s2')!, at: 0 })
    await internals(second.service).sweep()
    expect(kindOf(second.service, 's2')).toBe('normal')
    expect(missed(second.service)).toHaveLength(1)
    expect(internals(second.service).unverified.has('s2')).toBe(false)
    expect(seenRevisions(storage).s2).toBe('"r2"')
  })
})

describe('nearestSnoozeDeadline', () => {
  const snoozed = (id: string, until: number): [string, TaskRecord] => [id, {
    ...emptyRecord(id, 0),
    disposition: { kind: 'snoozed', until, setAt: 0, baselinePending: [], baselineTurnEndSeq: null, baselineUserInputAt: null },
  }]

  it('pushes a Snooze whose expiry write failed out to its retry instant', () => {
    const records = [snoozed('a', 10), snoozed('b', 40)]
    const live = () => ({ pinned: false, archived: false })
    expect(nearestSnoozeDeadline(records, live, id => (id === 'a' ? 100 : undefined))).toBe(40)
  })

  it('ignores frozen (pinned or archived) Snoozes so an expired frozen deadline cannot spin the timer', () => {
    const records = [snoozed('pinned', 10), snoozed('archived', 20), snoozed('live', 30)]
    const native = (id: string) => ({ pinned: id === 'pinned', archived: id === 'archived' })
    expect(nearestSnoozeDeadline(records, native)).toBe(30)
    expect(nearestSnoozeDeadline(records.slice(0, 2), native)).toBeNull()
  })
})

describe('sweepDelay', () => {
  it('keeps the fixed fallback instant instead of restarting the interval', () => {
    const now = 1_000_000
    const fallbackAt = now + 10_000
    expect(sweepDelay(fallbackAt, null, now)).toBe(10_005)
    expect(sweepDelay(fallbackAt, null, now + 9_000)).toBe(1_005)
    expect(sweepDelay(fallbackAt, now + 2_000, now)).toBe(2_005)
    expect(sweepDelay(fallbackAt, now - 50, now)).toBe(5)
  })
})

describe('unknownRetryDelay', () => {
  it('backs off from one minute and caps at thirty', () => {
    expect([1, 2, 3, 6, 20].map(unknownRetryDelay)).toEqual([60_000, 120_000, 240_000, 1_800_000, 1_800_000])
  })
})

describe('durablePendingOf', () => {
  it('proves "none" only from an exact read', () => {
    expect(durablePendingOf({ kind: 'sequenced', asOfSeq: 1, values: {} })).toEqual({ known: true, value: [] })
    expect(durablePendingOf({ kind: 'sequenced', asOfSeq: 1, values: { userQuestions: { active: [{ callId: 'c1', state: 'continued' }] } } }))
      .toEqual({ known: true, value: [{ source: 'userQuestions', key: 'c1', kind: 'user-question' }] })
    expect(durablePendingOf({ kind: 'migration-required', values: {} })).toEqual({ known: false })
    expect(durablePendingOf({ kind: 'migration-required', values: { userQuestions: { active: [{ callId: 'c2', state: 'open' }] } } }).known).toBe(true)
    expect(durablePendingOf(null)).toEqual({ known: false })
  })
})
