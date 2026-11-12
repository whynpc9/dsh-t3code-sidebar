/**
 * Policy scopes (P01) and result acknowledgement (P04) on the Host service:
 * workspace overrides, scoped grace windows, membership changes, the
 * keep-unacknowledged protections, and the read-only policy preview.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { T3SidebarService } from '../../src/host/service.ts'
import type { CommandInput, PolicyPreview } from '../../src/contracts/schema.ts'
import { appendStored, createFakeHost, MemoryDomainFacility, type FakeHost } from './fake-host.ts'

const DAY = 24 * 3_600_000
let hosts: FakeHost[] = []

afterEach(async () => {
  for (const host of hosts) await (host.ctx as unknown as { registry: { dispose?: () => unknown } }).registry?.dispose?.()
  hosts = []
})

interface Global {
  policyEligibleSince: number
  installedAt: number
  workspaceEligibleSince: Record<string, number>
  sessionEligibleSince: Record<string, number>
  membership: Record<string, string>
}

/** Two long-idle sessions (s1 in workspace "wa", s2 in none) whose install grace already passed. */
async function boot(setup?: (host: FakeHost) => void) {
  const storage = new MemoryDomainFacility()
  const host = createFakeHost(storage)
  const createdAt = Date.now() - 30 * DAY
  host.headers.push({ id: 's1', createdAt }, { id: 's2', createdAt })
  host.registry.workspaces.push({ id: 'wa', sessionIds: ['s1'] })
  setup?.(host)
  await (host.ctx as Context).plugin(T3SidebarService)
  const service = await new Promise<T3SidebarService>((resolve) => {
    const poll = () => { const s = (host.ctx as unknown as { get(n: string): unknown }).get('t3Sidebar') as T3SidebarService | undefined; if (s) resolve(s); else setTimeout(poll, 5) }
    poll()
  })
  await service.ready
  hosts.push(host)
  const global = () => storage.data.get('t3_sidebar')!.global as Global
  global().policyEligibleSince = 1
  global().installedAt = 1
  const sweep = () => (service as unknown as { sweep(): Promise<void> }).sweep()
  const settled = () => service.getSnapshot(1).tasks
    .filter(task => task.record.disposition.kind === 'settled').map(task => task.sessionId).sort()
  const view = (id: string) => service.getSnapshot(1).tasks.find(task => task.sessionId === id)
  const emit = (sessionId: string, type: string, seq: number, data: unknown, time: number) =>
    (host.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('session/event', { id: sessionId }, { type, seq, time, data })
  const setPolicy = (patch: Record<string, unknown>) => service.setPolicy({
    protocolVersion: 1,
    expectedRevision: service.getSnapshot(1).policy.revision,
    autoSettleAfterDays: 7,
    keepUnacknowledgedFailures: false,
    ...patch,
  })
  /** Replay the stored logs of the given sessions into their summaries (what a sweep starts in the background). */
  const rebuild = async (...ids: string[]) => {
    const internal = service as unknown as { rebuildHistory(ids: string[]): void; historyRebuild: Promise<void> | undefined }
    internal.rebuildHistory(ids)
    await internal.historyRebuild
  }
  return { host, service, storage, global, sweep, settled, view, emit, setPolicy, rebuild }
}

const command = (patch: Partial<CommandInput> & Pick<CommandInput, 'action'>): CommandInput => ({
  protocolVersion: 1, commandId: `cmd-${Math.random().toString(36).slice(2)}`, sessionId: 's1', expectedRevision: 0, observedPending: [], ...patch,
})

const settleTick = () => new Promise(resolve => setTimeout(resolve, 50))

describe('workspace policy overrides (P01)', () => {
  it('turns automatic settling off for one workspace while the Host default still applies elsewhere', async () => {
    const { service, sweep, settled, setPolicy, view } = await boot()
    expect(await setPolicy({ workspaceOverrides: { wa: { mode: 'off' } } })).toMatchObject({ ok: true })
    await sweep()
    expect(settled()).toEqual(['s2'])
    expect(service.previewPolicy({ protocolVersion: 1, draft: null }).skips).toEqual({ 'workspace-off': 1, parked: 1 })
    // Once s1 has a record (any command), its published view names the skip reason.
    await service.command(command({ action: { kind: 'policy-override', override: 'inherit' } }))
    expect(view('s1')?.autoSettleSkip).toBe('workspace-off')
  })

  it('applies a custom workspace window when the Host default is off, after the fresh grace it starts', async () => {
    const { sweep, settled, setPolicy, global } = await boot()
    const savedAt = Date.now()
    expect(await setPolicy({ autoSettleAfterDays: null, workspaceOverrides: { wa: { mode: 'custom', days: 2 } } })).toMatchObject({ ok: true })
    // Enabling a window for the workspace starts its grace now, for its members only.
    expect(global().workspaceEligibleSince['wa']).toBeGreaterThanOrEqual(savedAt)
    expect(global().policyEligibleSince).toBe(1) // turning the Host default off grants no grace
    await sweep()
    expect(settled()).toEqual([])
    global().workspaceEligibleSince['wa'] = 1 // the grace has run out
    await sweep()
    expect(settled()).toEqual(['s1'])
  })

  it('records the workspace rule on idle-timeout settles and in the audit', async () => {
    const { service, sweep, setPolicy, global } = await boot()
    await setPolicy({ autoSettleAfterDays: null, workspaceOverrides: { wa: { mode: 'custom', days: 3 } } })
    global().workspaceEligibleSince['wa'] = 1
    await sweep()
    const task = service.getSnapshot(1).tasks.find(entry => entry.sessionId === 's1')!
    expect(task.record.disposition).toMatchObject({ kind: 'settled', reason: 'idle-timeout', policyRevision: 1 })
    const disposition = task.record.disposition as { deadline: number; anchorAt: number }
    expect(disposition.deadline - disposition.anchorAt).toBe(3 * DAY)
    expect(service.listTransitions(10)).toMatchObject([{ sessionId: 's1', reason: 'idle-timeout', policyRevision: 1 }])
  })

  it('starts no grace when a workspace override becomes more lenient', async () => {
    const { setPolicy, global } = await boot()
    await setPolicy({ workspaceOverrides: { wa: { mode: 'custom', days: 30 } } })
    // No fresh window: only the (long expired) Host grace its members were owed carries over.
    expect(global().workspaceEligibleSince['wa']).toBe(1)
    const removedAt = Date.now()
    // Back to the 7-day default: stricter for wa's members.
    await setPolicy({ workspaceOverrides: {} })
    expect(global().workspaceEligibleSince['wa']).toBeGreaterThanOrEqual(removedAt)
  })

  it('gives a session a fresh grace window when its workspace (and so its rule) changes', async () => {
    const { host, sweep, settled, setPolicy, global } = await boot()
    await setPolicy({ workspaceOverrides: { wa: { mode: 'off' } } })
    await sweep()
    expect(global().membership).toEqual({ s1: 'wa', s2: '' })
    expect(settled()).toEqual(['s2'])
    // The workspace is removed: s1 now follows the 7-day default.
    const movedAt = Date.now()
    host.registry.workspaces.splice(0)
    await sweep()
    expect(global().sessionEligibleSince['s1']).toBeGreaterThanOrEqual(movedAt)
    expect(settled()).toEqual(['s2'])
    global().sessionEligibleSince['s1'] = 1
    await sweep()
    expect(settled()).toEqual(['s1', 's2'])
  })

  it('does not settle a session under its new rule until the membership grace is durable', async () => {
    const { host, storage, sweep, settled, setPolicy, global } = await boot()
    await setPolicy({ workspaceOverrides: { wa: { mode: 'off' } } })
    await sweep()
    expect(settled()).toEqual(['s2'])
    // s1 leaves the "off" workspace, but the grace write fails.
    host.registry.workspaces.splice(0)
    storage.failGlobalWrites = true
    await sweep()
    expect(settled()).toEqual(['s2'])
    // The write recovers: the grace is persisted and s1 still waits for it.
    storage.failGlobalWrites = false
    const movedAt = Date.now()
    await sweep()
    expect(global().sessionEligibleSince['s1']).toBeGreaterThanOrEqual(movedAt)
    expect(settled()).toEqual(['s2'])
  })

  it('keeps the grace a workspace still owed when the session leaves it under the same rule', async () => {
    const { host, sweep, settled, setPolicy, global } = await boot()
    await setPolicy({ workspaceOverrides: { wa: { mode: 'off' } } })
    await sweep()
    expect(settled()).toEqual(['s2'])
    // Removing the "off" override is stricter for wa's members: they get a fresh window…
    await setPolicy({ workspaceOverrides: {} })
    const owed = global().workspaceEligibleSince['wa']!
    expect(owed).toBeGreaterThan(Date.now() - 60_000)
    // …which s1 keeps after leaving wa, although host:7 → host:7 is the same rule.
    host.registry.workspaces.splice(0)
    await sweep()
    expect(global().sessionEligibleSince['s1']).toBe(owed)
    expect(settled()).toEqual(['s2'])
  })

  it('does not delay cold sessions under an unchanged workspace rule when the Host default changes', async () => {
    const { sweep, settled, setPolicy, global } = await boot()
    await setPolicy({ workspaceOverrides: { wa: { mode: 'custom', days: 2 } } })
    global().workspaceEligibleSince['wa'] = 1 // wa's own grace has run out
    // Shortening the Host default starts a grace for its followers (s2) only.
    await setPolicy({ autoSettleAfterDays: 3, workspaceOverrides: { wa: { mode: 'custom', days: 2 } } })
    await sweep()
    expect(settled()).toEqual(['s1'])
  })

  it('judges the membership snapshot whose grace it persisted, not a later registry read', async () => {
    const { host, storage, sweep, settled, setPolicy } = await boot()
    await setPolicy({ workspaceOverrides: { wa: { mode: 'off' } } })
    await sweep()
    expect(settled()).toEqual(['s2'])
    // s2 joining another workspace makes the next sweep write membership; while
    // that write is in flight, s1 leaves the "off" workspace.
    host.registry.workspaces.push({ id: 'wb', sessionIds: ['s2'] })
    let release!: () => void
    storage.globalGate = new Promise<void>((resolve) => { release = resolve })
    const pass = sweep()
    await new Promise(resolve => setTimeout(resolve, 20))
    host.registry.workspaces.splice(0, 1)
    storage.globalGate = null
    release()
    await pass
    expect(settled()).toEqual(['s2'])
  })

  it('keeps the Host grace a workspace still owed when it starts overriding the default with a longer window', async () => {
    const { sweep, settled, setPolicy, global } = await boot()
    // Enabling the Host default starts a grace for its followers (s1 and s2)…
    await setPolicy({ autoSettleAfterDays: null })
    await setPolicy({ autoSettleAfterDays: 7 })
    const hostGrace = global().policyEligibleSince
    expect(hostGrace).toBeGreaterThan(Date.now() - 60_000)
    // …and wa switching to a longer window must not drop what s1 is still owed.
    await setPolicy({ workspaceOverrides: { wa: { mode: 'custom', days: 30 } } })
    expect(global().workspaceEligibleSince['wa']).toBe(hostGrace)
    await sweep()
    expect(settled()).toEqual([])
    // An unchanged override keeps its grace.
    await setPolicy({ keepUnacknowledgedResults: false, workspaceOverrides: { wa: { mode: 'custom', days: 30 } } })
    expect(global().workspaceEligibleSince['wa']).toBe(hostGrace)
  })

  it('settles nothing under workspace overrides while membership cannot be read', async () => {
    const { host, sweep, settled, setPolicy, service } = await boot()
    await setPolicy({ workspaceOverrides: { wa: { mode: 'off' } } })
    host.registry.list = () => { throw new Error('registry unavailable') }
    ;(service as unknown as { membershipCache: unknown }).membershipCache = undefined
    await sweep()
    expect(settled()).toEqual([])
    expect(service.previewPolicy({ protocolVersion: 1, draft: null }).skips).toEqual({ 'scope-unknown': 2 })
  })

  it('validates override values on the Host', async () => {
    const { setPolicy } = await boot()
    expect(await setPolicy({ workspaceOverrides: { wa: { mode: 'custom', days: 0 } } })).toMatchObject({ ok: false, code: 'PROTOCOL_MISMATCH' })
    expect(await setPolicy({ workspaceOverrides: { wa: { mode: 'never' } } })).toMatchObject({ ok: false, code: 'PROTOCOL_MISMATCH' })
  })
})

describe('result acknowledgement (P04)', () => {
  it('keeps an unacknowledged result under keepUnacknowledgedResults until it is acknowledged', async () => {
    const { service, sweep, settled, setPolicy, emit, global, rebuild } = await boot()
    const old = Date.now() - 20 * DAY
    emit('s1', 'turn/start', 3, {}, old)
    emit('s1', 'turn/end', 4, { reason: { kind: 'completed' } }, old)
    await settleTick()
    await setPolicy({ keepUnacknowledgedResults: true })
    await rebuild('s1', 's2')
    await sweep()
    expect(settled()).toEqual(['s2'])
    const held = service.getSnapshot(1).tasks.find(task => task.sessionId === 's1')!
    expect(held.autoSettleSkip).toBe('unacknowledged-result')

    const future = await service.command(command({ expectedRevision: held.record.revision, action: { kind: 'acknowledge-result', turnEndSeq: 9 } }))
    expect(future).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const ack = await service.command(command({ expectedRevision: held.record.revision, action: { kind: 'acknowledge-result', turnEndSeq: 4 } }))
    expect(ack).toMatchObject({ ok: true, task: { record: { resultAcknowledgedSeq: 4 } } })
    // Acknowledging an older result again never moves the mark backwards.
    const again = await service.command(command({ expectedRevision: held.record.revision + 1, action: { kind: 'acknowledge-result', turnEndSeq: 2 } }))
    expect(again).toMatchObject({ ok: true, task: { record: { resultAcknowledgedSeq: 4 } } })
    global().policyEligibleSince = 1
    await sweep()
    expect(settled()).toEqual(['s1', 's2'])
  })

  it('treats blocked, max-tokens, interrupted and unknown endings as failures', async () => {
    const { service, sweep, setPolicy, emit, rebuild } = await boot()
    const old = Date.now() - 20 * DAY
    emit('s1', 'turn/end', 4, { reason: { kind: 'max-tokens' } }, old)
    emit('s2', 'turn/end', 4, { reason: { kind: 'aborted' } }, old)
    await settleTick()
    await setPolicy({ keepUnacknowledgedFailures: true })
    await rebuild('s1', 's2')
    await sweep()
    const tasks = service.getSnapshot(1).tasks
    expect(tasks.find(task => task.sessionId === 's1')).toMatchObject({ record: { disposition: { kind: 'normal' } }, autoSettleSkip: 'unacknowledged-failure' })
    expect(tasks.find(task => task.sessionId === 's2')).toMatchObject({ record: { disposition: { kind: 'settled' } } })
  })

  it('rebuilds a result written before this process started before a keep protection can pass', async () => {
    const { service, host, sweep, settled, setPolicy } = await boot()
    // s1's failure is only in its stored log (it ended while the Host half was not running).
    appendStored(host, 's1', 'turn/start', {}, Date.now() - 20 * DAY)
    appendStored(host, 's1', 'turn/end', { reason: { kind: 'error' } }, Date.now() - 20 * DAY)
    await setPolicy({ keepUnacknowledgedFailures: true })
    await sweep()
    // Neither session is settled while its latest result is not known; both rebuilds start.
    expect(settled()).toEqual([])
    expect(service.previewPolicy({ protocolVersion: 1, draft: null }).skips).toMatchObject({ 'result-unknown': 2 })
    await (service as unknown as { historyRebuild: Promise<void> | undefined }).historyRebuild
    await sweep()
    expect(settled()).toEqual(['s2'])
    const s1 = service.getSnapshot(1).tasks.find(task => task.sessionId === 's1')!
    expect(s1.record.activity.lastTurnEnd).toMatchObject({ seq: 1, reason: 'error' })
    expect(s1.autoSettleSkip).toBe('unacknowledged-failure')
    expect(service.previewPolicy({ protocolVersion: 1, draft: null }).held).toEqual([{ sessionId: 's1', turnEndSeq: 1, reason: 'unacknowledged-failure' }])
  })

  it('keeps a session unsettled while its stored log cannot be read', async () => {
    const { host, sweep, settled, setPolicy, service } = await boot()
    host.replayFail = true
    await setPolicy({ keepUnacknowledgedResults: true })
    await sweep()
    await (service as unknown as { historyRebuild: Promise<void> | undefined }).historyRebuild
    await sweep()
    expect(settled()).toEqual([])
  })

  it('starts a fresh grace window when a keep protection is released', async () => {
    const { setPolicy, global } = await boot()
    await setPolicy({ keepUnacknowledgedFailures: true, workspaceOverrides: { wa: { mode: 'custom', days: 30 } } })
    const releasedAt = Date.now()
    await setPolicy({ keepUnacknowledgedFailures: false, workspaceOverrides: { wa: { mode: 'custom', days: 30 } } })
    expect(global().policyEligibleSince).toBeGreaterThanOrEqual(releasedAt)
    expect(global().workspaceEligibleSince['wa']).toBeGreaterThanOrEqual(releasedAt)
  })

  it('reads acknowledgement-free records written before this field existed', async () => {
    const storage = new MemoryDomainFacility()
    const unit = await storage.open({ name: 't3_sidebar', tables: { tasks: { valueSchema: { parse: (v: unknown) => v } as never }, transitions: { valueSchema: { parse: (v: unknown) => v } as never } } })
    await unit.table('tasks').put('s1', {
      sessionId: 's1', revision: 2, disposition: { kind: 'normal' }, autoSettleHold: null, policyOverride: 'inherit',
      policyEligibleSince: 1, lastSnoozeWakeAt: null,
      activity: { lastUserInputAt: null, lastTurnStartAt: null, lastTurnStartSeq: null, lastTurnEnd: null }, receipts: [],
    })
    const { TaskRecordSchema } = await import('../../src/contracts/schema.ts')
    expect(TaskRecordSchema.parse(unit.table('tasks').get('s1')).resultAcknowledgedSeq).toBeNull()
  })
})

describe('previewPolicy', () => {
  it('counts due sessions, skip reasons and held results without writing', async () => {
    const { service, emit, storage, rebuild } = await boot()
    const old = Date.now() - 20 * DAY
    emit('s1', 'turn/end', 4, { reason: { kind: 'error' } }, old)
    await settleTick()
    await rebuild('s1', 's2')
    const before = JSON.stringify(storage.data.get('t3_sidebar')!.global)
    const current = service.previewPolicy({ protocolVersion: 1, draft: null })
    expect(current).toMatchObject<Partial<PolicyPreview>>({ policyRevision: 0, sessions: 2, due: 2, heldTotal: 0 })
    const draft = service.previewPolicy({
      protocolVersion: 1,
      draft: { autoSettleAfterDays: 7, keepUnacknowledgedFailures: true, keepUnacknowledgedResults: false, workspaceOverrides: {} },
    })
    expect(draft).toMatchObject({ due: 1, heldTotal: 1, held: [{ sessionId: 's1', turnEndSeq: 4, reason: 'unacknowledged-failure' }] })
    expect(JSON.stringify(storage.data.get('t3_sidebar')!.global)).toBe(before)
  })

  it('applies the grace a draft would start, and reports the next deadline', async () => {
    const { service } = await boot()
    const preview = service.previewPolicy({
      protocolVersion: 1,
      draft: { autoSettleAfterDays: 3, keepUnacknowledgedFailures: false, keepUnacknowledgedResults: false, workspaceOverrides: { wa: { mode: 'off' } } },
    })
    // Shortening 7 → 3 days starts a fresh grace for the Host default's followers: nothing is due yet.
    expect(preview.due).toBe(0)
    expect(preview.skips).toMatchObject({ 'not-due': 1, 'workspace-off': 1 })
    expect(preview.nextDeadline?.sessionId).toBe('s2')
    expect(preview.nextDeadline!.at).toBeGreaterThan(Date.now() + 2.9 * DAY)
  })

  it('rejects another protocol version', async () => {
    const { service } = await boot()
    expect(() => service.previewPolicy({ protocolVersion: 2, draft: null })).toThrow(/protocol/)
  })
})

describe('history knowledge for keep protections (review follow-ups)', () => {
  const internal = (service: T3SidebarService) => service as unknown as {
    rebuildHistory(ids: string[]): void
    historyRebuild: Promise<void> | undefined
    resultHistoryKnown(id: string): boolean
    failedFolds: Set<string>
  }

  it('rebuilds history even when the cached summary already holds an older failure', async () => {
    const { service, host, sweep, settled, setPolicy, emit } = await boot()
    const old = Date.now() - 20 * DAY
    // The Host saw an old failure live (in an earlier run)…
    emit('s1', 'turn/end', 2, { reason: { kind: 'error' } }, old)
    await settleTick()
    // …and a later success happened while it was not running (only in the stored log).
    appendStored(host, 's1', 'turn/start', {}, old)
    appendStored(host, 's1', 'turn/end', { reason: { kind: 'error' } }, old)
    appendStored(host, 's1', 'turn/start', {}, old + 1000)
    appendStored(host, 's1', 'turn/end', { reason: { kind: 'completed' } }, old + 2000)
    await setPolicy({ keepUnacknowledgedFailures: true })
    await sweep()
    expect(service.getSnapshot(1).tasks.find(task => task.sessionId === 's1')?.autoSettleSkip).toBe('result-unknown')
    await internal(service).historyRebuild
    await sweep()
    expect(service.getSnapshot(1).tasks.find(task => task.sessionId === 's1')?.record.activity.lastTurnEnd).toMatchObject({ seq: 3, reason: 'completed' })
    expect(settled()).toEqual(['s1', 's2'])
  })

  it('trusts creation time only for sessions created after the event listener was installed', async () => {
    const storage = new MemoryDomainFacility()
    let release!: () => void
    storage.openGate = new Promise<void>((resolve) => { release = resolve })
    const host = createFakeHost(storage)
    hosts.push(host)
    void (host.ctx as Context).plugin(T3SidebarService)
    await new Promise(resolve => setTimeout(resolve, 20))
    // Created (and possibly finished a turn) while storage was still opening: its events were not observed.
    host.headers.push({ id: 'early', createdAt: Date.now() })
    storage.openGate = null
    release()
    const service = await new Promise<T3SidebarService>((resolve) => {
      const poll = () => { const s = (host.ctx as unknown as { get(n: string): unknown }).get('t3Sidebar') as T3SidebarService | undefined; if (s) resolve(s); else setTimeout(poll, 5) }
      poll()
    })
    await service.ready
    await new Promise(resolve => setTimeout(resolve, 5))
    ;(service as unknown as { rememberHeader(header: unknown): void }).rememberHeader({ id: 'late', createdAt: Date.now() })
    const known = (id: string) => internal(service).resultHistoryKnown.call(service, id)
    expect(known('early')).toBe(false)
    expect(known('late')).toBe(true)
  })

  it('keeps a session settled when its history replay lands after the user settled it', async () => {
    const { service, host, rebuild } = await boot()
    const old = Date.now() - 20 * DAY
    appendStored(host, 's1', 'user/message', { source: { kind: 'user' } }, old)
    appendStored(host, 's1', 'turn/start', {}, old + 1)
    appendStored(host, 's1', 'turn/end', { reason: { kind: 'completed' } }, old + 2)
    // Settled from the incomplete (empty) summary, before the replay ran.
    const settled = await service.command({ protocolVersion: 1, commandId: 'cmd-settle-cold', sessionId: 's1', expectedRevision: 0, observedPending: [], action: { kind: 'settle' } })
    expect(settled).toMatchObject({ ok: true })
    await rebuild('s1')
    const task = service.getSnapshot(1).tasks.find(entry => entry.sessionId === 's1')!
    expect(task.record.activity.lastUserInputAt).toBe(old)
    expect(task.record.disposition).toMatchObject({ kind: 'settled', baselineUserInputAt: old, baselineTurnStartSeq: 1 })
  })

  it('keeps a failed live fold unknown after catch-up clears it, until a replay succeeds', async () => {
    const { service, storage, emit, rebuild } = await boot()
    // A session created by this process would be known by its creation time…
    const fresh = internal(service)
    storage.failTableWrites = true
    emit('s1', 'turn/end', 2, { reason: { kind: 'error' } }, Date.now())
    await settleTick()
    storage.failTableWrites = false
    expect(fresh.resultHistoryKnown('s1')).toBe(false)
    // Catch-up forgets the failed fold after resetting the grace window; history stays unknown.
    fresh.failedFolds.delete('s1')
    expect(fresh.resultHistoryKnown('s1')).toBe(false)
    await rebuild('s1')
    expect(fresh.resultHistoryKnown('s1')).toBe(true)
  })
})
