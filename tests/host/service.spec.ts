import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { nearestSnoozeDeadline, sweepDelay, T3SidebarService } from '../../src/host/service.ts'
import { emptyRecord, type TaskRecord } from '../../src/domain/types.ts'
import type { CommandInput, FollowEvent } from '../../src/contracts/schema.ts'
import { createFakeHost, MemoryDomainFacility, type FakeHost } from './fake-host.ts'

const HOUR = 3_600_000
let hosts: FakeHost[] = []

async function boot(storage?: MemoryDomainFacility, revisions: Record<string, string> = {}) {
  const host = createFakeHost(storage)
  host.headers.push(
    { id: 's1', createdAt: Date.now() - 1000, revision: revisions.s1 },
    { id: 's2', createdAt: Date.now() - 1000, revision: revisions.s2 },
    { id: 'child', createdAt: 0, origin: 'subagent' },
  )
  await (host.ctx as Context).plugin(T3SidebarService)
  const service = await new Promise<T3SidebarService>((resolve) => {
    const poll = () => { const s = (host.ctx as unknown as { get(n: string): unknown }).get('t3Sidebar') as T3SidebarService | undefined; if (s) resolve(s); else setTimeout(poll, 5) }
    poll()
  })
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
    const reenabledAt = Date.now()
    const second = await boot(storage, { s1: 'r2', s2: 'r1' })
    const tasks = second.service.getSnapshot(1).tasks
    expect(tasks.find(task => task.sessionId === 's1')?.record.policyEligibleSince).toBeGreaterThanOrEqual(reenabledAt)
    expect(tasks.find(task => task.sessionId === 's2')).toBeUndefined()
  })

  it('surfaces Settled and Snoozed tasks whose session changed while the plugin was away', async () => {
    const storage = new MemoryDomainFacility()
    const first = await boot(storage, { s1: 'r1', s2: 'r1' })
    await first.service.command(command({ sessionId: 's1', action: { kind: 'settle' } }))
    await first.service.command(command({ sessionId: 's2', action: { kind: 'snooze', until: Date.now() + HOUR } }))
    const second = await boot(storage, { s1: 'r2', s2: 'r2' })
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

describe('nearestSnoozeDeadline', () => {
  const snoozed = (id: string, until: number): [string, TaskRecord] => [id, {
    ...emptyRecord(id, 0),
    disposition: { kind: 'snoozed', until, setAt: 0, baselinePending: [], baselineTurnEndSeq: null, baselineUserInputAt: null },
  }]

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
