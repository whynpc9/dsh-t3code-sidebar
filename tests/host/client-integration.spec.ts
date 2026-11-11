/**
 * End-to-end commit and recovery evidence (issue #4 §C): two Client
 * `HostBackend`s against the real Host service and in-memory storage, with
 * replies, deltas and the Host itself failing at chosen points. Each case
 * asserts storage, what the caller was told, and both windows' final state.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { HostBackend, type CommandContext, type FollowStream, type RecoveryNotice, type T3Remote } from '../../src/client/backend.ts'
import type { FollowEvent } from '../../src/contracts/schema.ts'
import { T3SidebarService } from '../../src/host/service.ts'
import { EMPTY_ACTIVITY, known } from '../../src/domain/types.ts'
import { createFakeHost, MemoryDomainFacility, type FakeHost } from './fake-host.ts'

const HOUR = 3_600_000
const context: CommandContext = {
  native: { pinned: false, archived: false },
  facts: { running: known(false), pending: known([]), activity: known([]), summary: EMPTY_ACTIVITY },
  observedPending: [],
}

interface Booted { host: FakeHost; service: T3SidebarService; stop: () => Promise<void> }
let booted: Booted[] = []
let backends: HostBackend[] = []

async function boot(storage = new MemoryDomainFacility()): Promise<Booted> {
  const host = createFakeHost(storage)
  host.headers.push({ id: 's1', createdAt: Date.now() - 1000 }, { id: 's2', createdAt: Date.now() - 1000 })
  const fiber = (host.ctx as Context).plugin(T3SidebarService)
  await fiber
  const service = await new Promise<T3SidebarService>((resolve) => {
    const poll = () => { const s = (host.ctx as unknown as { get(n: string): unknown }).get('t3Sidebar') as T3SidebarService | undefined; if (s) resolve(s); else setTimeout(poll, 5) }
    poll()
  })
  await service.ready
  const entry = { host, service, stop: async () => { await fiber.dispose() } }
  booted.push(entry)
  return entry
}

/** Faults injected between one window and the Host. */
interface Link {
  /** Commit on the Host, then lose the reply (once per armed call). */
  loseNextCommandReply: boolean
  loseNextPolicyReply: boolean
  /** Drop the next delta this window would receive. */
  dropNextDelta: boolean
}

function link(service: () => T3SidebarService): { remote: T3Remote; faults: Link } {
  const faults: Link = { loseNextCommandReply: false, loseNextPolicyReply: false, dropNextDelta: false }
  const remote: T3Remote = {
    getSnapshot: async version => ({ ok: true, value: service().getSnapshot(version) }),
    follow(version, signal) {
      const source = service().follow(version, signal ?? new AbortController().signal)
      const filtered = (async function* () {
        for await (const event of source) {
          if (event.kind === 'delta' && faults.dropNextDelta) { faults.dropNextDelta = false; continue }
          yield event as FollowEvent
        }
      })()
      return filtered as FollowStream
    },
    async command(input) {
      const value = await service().command(input)
      if (faults.loseNextCommandReply) { faults.loseNextCommandReply = false; throw new Error('connection lost') }
      return { ok: true, value }
    },
    async setPolicy(input) {
      const value = await service().setPolicy(input)
      if (faults.loseNextPolicyReply) { faults.loseNextPolicyReply = false; throw new Error('connection lost') }
      return { ok: true, value }
    },
    listTransitions: async limit => ({ ok: true, value: service().listTransitions(limit) }),
  }
  return { remote, faults }
}

function window(remote: T3Remote, service: T3SidebarService) {
  const notices: RecoveryNotice[] = []
  const backend = new HostBackend(remote, service.getSnapshot(1), () => {}, {
    onConnectionReset: () => () => {},
    onRecovery: notice => notices.push(notice),
    retryDelay: () => 5,
  })
  backends.push(backend)
  return { backend, notices }
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 5))
}

const recordOf = (backend: HostBackend, sessionId = 's1') => backend.state.getSnapshot().tasks.get(sessionId)?.record
const stored = (service: T3SidebarService, sessionId = 's1') => service.getSnapshot(1).tasks.find(task => task.sessionId === sessionId)?.record

afterEach(async () => {
  for (const backend of backends) backend.dispose()
  for (const entry of booted) await entry.stop().catch(() => undefined)
  backends = []
  booted = []
})

describe('two windows against the Host', () => {
  it('one concurrent command wins, the other is a clear conflict, and both windows converge', async () => {
    const { service } = await boot()
    const a = window(link(() => service).remote, service)
    const b = window(link(() => service).remote, service)
    await settle()
    const [left, right] = await Promise.all([
      a.backend.command('s1', { kind: 'snooze', until: Date.now() + HOUR }, context),
      b.backend.command('s1', { kind: 'settle' }, context),
    ])
    const results = [left, right]
    expect(results.filter(result => result.ok)).toHaveLength(1)
    const loser = results.find(result => !result.ok)
    expect(loser).toMatchObject({ ok: false, code: 'CONFLICT', task: { record: { revision: 1 } } })
    await settle()
    const committed = stored(service)!
    expect(committed.revision).toBe(1)
    for (const { backend } of [a, b]) {
      expect(backend.state.getSnapshot().status).toBe('ready')
      expect(recordOf(backend)).toEqual(committed)
    }
    expect(service.listTransitions(10)).toHaveLength(1)
  })

  it('confirms a command whose reply was lost after the commit by resending the same commandId', async () => {
    const { service } = await boot()
    const linkA = link(() => service)
    const a = window(linkA.remote, service)
    const b = window(link(() => service).remote, service)
    await settle()
    linkA.faults.loseNextCommandReply = true
    const result = await a.backend.command('s1', { kind: 'settle' }, context)
    expect(result).toMatchObject({ ok: false, code: 'UNCONFIRMED' }) // never reported as "not committed"
    await settle()
    expect(a.notices).toEqual([{ kind: 'command', outcome: 'committed', sessionId: 's1' }])
    const committed = stored(service)!
    expect(committed).toMatchObject({ revision: 1, disposition: { kind: 'settled' } })
    expect(committed.receipts).toHaveLength(1) // one logical command, one receipt
    expect(service.listTransitions(10)).toHaveLength(1)
    expect(recordOf(a.backend)).toEqual(committed)
    expect(recordOf(b.backend)).toEqual(committed)
    expect(a.backend.state.getSnapshot().status).toBe('ready')
  })

  it('reports a committed command as committed when only bookkeeping fails', async () => {
    const storage = new MemoryDomainFacility()
    const { service } = await boot(storage)
    const a = window(link(() => service).remote, service)
    const b = window(link(() => service).remote, service)
    await settle()
    storage.failGlobalWrites = true
    storage.failAuditWrites = true
    const result = await a.backend.command('s1', { kind: 'settle' }, context)
    expect(result).toMatchObject({ ok: true, task: { record: { revision: 1, disposition: { kind: 'settled' } } } })
    await settle()
    expect(stored(service)).toMatchObject({ revision: 1, disposition: { kind: 'settled' } })
    // Best-effort audit: the transition entry is missing, the state is not.
    expect(service.listTransitions(10)).toHaveLength(0)
    expect(recordOf(b.backend)).toEqual(stored(service))
  })

  it('reports a failed primary write as not applied and changes nothing anywhere', async () => {
    const storage = new MemoryDomainFacility()
    const { service } = await boot(storage)
    const a = window(link(() => service).remote, service)
    const b = window(link(() => service).remote, service)
    await settle()
    storage.failTableWrites = true
    const result = await a.backend.command('s1', { kind: 'settle' }, context)
    expect(result).toMatchObject({ ok: false, code: 'STORAGE_UNAVAILABLE' })
    await settle()
    expect(stored(service)).toBeUndefined()
    // A may show the unchanged implicit record the reply carried (revision 0).
    expect(recordOf(a.backend)).toMatchObject({ revision: 0, disposition: { kind: 'normal' } })
    expect(recordOf(b.backend)).toBeUndefined()
    expect(a.notices).toEqual([])
  })

  it('recovers a window that lost a follow delta through a fresh baseline', async () => {
    const { service } = await boot()
    const a = window(link(() => service).remote, service)
    const linkB = link(() => service)
    const b = window(linkB.remote, service)
    await settle()
    linkB.faults.dropNextDelta = true
    await a.backend.command('s1', { kind: 'settle' }, context)
    await settle()
    expect(recordOf(b.backend)).toBeUndefined() // the delta was lost; nothing reveals it yet
    await a.backend.command('s2', { kind: 'settle' }, context)
    await settle()
    // The next delta exposed the gap; B resubscribed and has both changes.
    expect(b.backend.state.getSnapshot().status).toBe('ready')
    expect(recordOf(b.backend, 's1')).toEqual(stored(service, 's1'))
    expect(recordOf(b.backend, 's2')).toEqual(stored(service, 's2'))
  })

  it('confirms a lost reply across a Host restart from the persisted receipt', async () => {
    const storage = new MemoryDomainFacility()
    let current = await boot(storage)
    const linkA = link(() => current.service)
    const a = window(linkA.remote, current.service)
    const b = window(link(() => current.service).remote, current.service)
    await settle()
    linkA.faults.loseNextCommandReply = true
    // The Host stops right after committing; the reply never arrives.
    const pending = a.backend.command('s1', { kind: 'settle' }, context)
    const result = await pending
    expect(result).toMatchObject({ code: 'UNCONFIRMED' })
    await current.stop()
    const restarted = await boot(storage)
    current = restarted
    // The Remote namespace is re-provided by the restarted Host.
    a.backend.replaceApi(link(() => restarted.service).remote)
    b.backend.replaceApi(link(() => restarted.service).remote)
    await settle()
    expect(a.notices).toEqual([{ kind: 'command', outcome: 'committed', sessionId: 's1' }])
    const committed = stored(restarted.service)!
    expect(committed).toMatchObject({ revision: 1, disposition: { kind: 'settled' } })
    expect(committed.receipts).toHaveLength(1)
    expect(restarted.service.listTransitions(10)).toHaveLength(1)
    expect(recordOf(a.backend)).toEqual(committed)
    expect(recordOf(b.backend)).toEqual(committed)
  })

  it('settles a lost policy reply from the next baseline without resending it', async () => {
    const { service } = await boot()
    const linkA = link(() => service)
    const a = window(linkA.remote, service)
    const b = window(link(() => service).remote, service)
    await settle()
    linkA.faults.loseNextPolicyReply = true
    expect(await a.backend.setPolicy(3, true)).toMatchObject({ ok: false, code: 'UNCONFIRMED' })
    await settle()
    expect(a.notices).toEqual([{ kind: 'policy', outcome: 'committed' }])
    const policy = service.getSnapshot(1).policy
    expect(policy).toEqual({ revision: 1, autoSettleAfterDays: 3, keepUnacknowledgedFailures: true })
    expect(a.backend.state.getSnapshot().policy).toEqual(policy)
    expect(b.backend.state.getSnapshot().policy).toEqual(policy)
  })
})
