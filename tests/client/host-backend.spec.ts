/**
 * HostBackend generation isolation (issue #4 §A): old streams, late RPC
 * replies and disposed instances never write the current state, and writes are
 * accepted only after a fresh baseline of the current subscription.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostBackend, type CommandContext, type RecoveryNotice } from '../../src/client/backend.ts'
import { EMPTY_ACTIVITY, known } from '../../src/domain/types.ts'
import { baseline, delta, FakeRemote, flush, POLICY, ResetSource, snapshot, taskView } from './remote-fakes.ts'

const context: CommandContext = {
  native: { pinned: false, archived: false },
  facts: { running: known(false), pending: known([]), activity: known([]), summary: EMPTY_ACTIVITY },
  observedPending: [],
}

let remote: FakeRemote
let resets: ResetSource
let unmounts: number
let notices: RecoveryNotice[]
let backends: HostBackend[]

function start(initial = snapshot('e1', 0), retryDelay = (attempt: number) => 1000 * (attempt + 1)): HostBackend {
  const backend = new HostBackend(remote, initial, () => { unmounts += 1 }, {
    onConnectionReset: resets.subscribe,
    onRecovery: notice => notices.push(notice),
    retryDelay,
  })
  backends.push(backend)
  return backend
}

/** Open the first stream with its baseline. */
async function ready(backend: HostBackend, epoch = 'e1', seq = 0, tasks = [taskView('s1', 1)]) {
  remote.stream.push(baseline(epoch, seq, tasks))
  await flush()
  expect(backend.state.getSnapshot().status).toBe('ready')
}

beforeEach(() => {
  remote = new FakeRemote()
  resets = new ResetSource()
  unmounts = 0
  notices = []
  backends = []
})

afterEach(() => {
  for (const backend of backends) backend.dispose()
  vi.useRealTimers()
})

describe('HostBackend generations', () => {
  it('ignores deltas of the stream a reset replaced and stays stale until the new baseline', async () => {
    remote.honorAbort = false // the old connection keeps delivering
    const backend = start()
    await ready(backend)
    const old = remote.stream
    old.push(delta('e1', 1, [taskView('s1', 2)]))
    await flush()
    expect(backend.state.getSnapshot().tasks.get('s1')?.record.revision).toBe(2)

    resets.fire()
    expect(backend.state.getSnapshot().status).toBe('stale')
    expect(old.aborted).toBe(true)
    expect(remote.streams).toHaveLength(2) // resubscribed at once
    old.push(delta('e1', 2, [taskView('s1', 3)]))
    old.push(delta('e1', 3, [taskView('s2', 1)]))
    await flush()
    const stale = backend.state.getSnapshot()
    expect(stale.status).toBe('stale')
    expect(stale.tasks.get('s1')?.record.revision).toBe(2)
    expect(stale.tasks.has('s2')).toBe(false)

    remote.stream.push(baseline('e1', 5, [taskView('s1', 4)]))
    await flush()
    const fresh = backend.state.getSnapshot()
    expect(fresh.status).toBe('ready')
    expect([...fresh.tasks.keys()]).toEqual(['s1'])
    expect(fresh.tasks.get('s1')?.record.revision).toBe(4)
  })

  it('resubscribes immediately on a sequence gap even though the connection is alive', async () => {
    remote.honorAbort = false
    const backend = start()
    await ready(backend)
    const old = remote.stream
    old.push(delta('e1', 2, [taskView('s1', 5)])) // seq 1 missing
    await flush()
    expect(backend.state.getSnapshot().status).toBe('stale')
    expect(backend.state.getSnapshot().tasks.get('s1')?.record.revision).toBe(1)
    expect(remote.streams).toHaveLength(2)
    // The missing delta arriving late on the abandoned stream changes nothing.
    old.push(delta('e1', 1, [taskView('s1', 2)]))
    await flush()
    expect(backend.state.getSnapshot()).toMatchObject({ status: 'stale' })
    remote.stream.push(baseline('e1', 2, [taskView('s1', 5)]))
    await flush()
    expect(backend.state.getSnapshot()).toMatchObject({ status: 'ready' })
    expect(backend.state.getSnapshot().tasks.get('s1')?.record.revision).toBe(5)
  })

  it('treats an epoch change or a delta before the baseline as a reason to resubscribe (with backoff when repeated)', async () => {
    vi.useFakeTimers()
    const backend = start()
    await ready(backend)
    remote.stream.push(delta('e2', 1, [taskView('s1', 9)]))
    await flush()
    expect(backend.state.getSnapshot().status).toBe('stale')
    expect(backend.state.getSnapshot().tasks.get('s1')?.record.revision).toBe(1)
    expect(remote.streams).toHaveLength(2)
    remote.stream.push(delta('e2', 1)) // new stream, no baseline yet
    await flush()
    expect(backend.state.getSnapshot().status).toBe('stale')
    // No baseline since the last attempt: the next one waits (no hot loop).
    expect(remote.streams).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(remote.streams).toHaveLength(3)
  })

  it('drops a command reply sent before a reset when it arrives after the new baseline', async () => {
    const backend = start()
    await ready(backend)
    const pending = backend.command('s1', { kind: 'settle' }, context)
    await flush()
    resets.fire()
    remote.stream.push(baseline('e2', 0, [taskView('s1', 1)]))
    await flush()
    remote.commands[0]!.reply.resolve({ ok: true, value: { ok: true, task: taskView('s1', 7, 'settled'), dataRevision: 1, replayed: false } })
    const result = await pending
    expect(result.ok).toBe(true) // the caller still learns the outcome
    const state = backend.state.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.tasks.get('s1')?.record.revision).toBe(1) // the stream, not the old reply, updates it
    remote.stream.push(delta('e2', 1, [taskView('s1', 7, 'settled')]))
    await flush()
    expect(backend.state.getSnapshot().tasks.get('s1')?.record.disposition.kind).toBe('settled')
  })

  it('does not let a delta of an older revision undo a newer command reply', async () => {
    const backend = start()
    await ready(backend)
    const pending = backend.command('s1', { kind: 'settle' }, context)
    await flush()
    remote.commands[0]!.reply.resolve({ ok: true, value: { ok: true, task: taskView('s1', 3, 'settled'), dataRevision: 1, replayed: false } })
    await pending
    remote.stream.push(delta('e1', 1, [taskView('s1', 2)]))
    await flush()
    expect(backend.state.getSnapshot().tasks.get('s1')?.record.revision).toBe(3)
  })

  it('refuses task and policy writes until a fresh baseline arrives', async () => {
    const backend = start()
    await ready(backend)
    resets.fire()
    expect(await backend.command('s1', { kind: 'settle' }, context)).toMatchObject({ ok: false, code: 'BASELINE_PENDING' })
    expect(await backend.setPolicy(3, false)).toMatchObject({ ok: false, code: 'BASELINE_PENDING', policy: POLICY })
    expect(remote.commands).toHaveLength(0)
    expect(remote.policies).toHaveLength(0)
    remote.stream.push(baseline('e1', 0, [taskView('s1', 1)]))
    await flush()
    void backend.command('s1', { kind: 'settle' }, context)
    await flush()
    expect(remote.commands).toHaveLength(1)
    expect(remote.commands[0]!.input).toMatchObject({ expectedRevision: 1, sessionId: 's1' })
  })

  it('keeps the newest policy when two replies arrive in reverse order', async () => {
    const backend = start()
    await ready(backend)
    const first = backend.setPolicy(5, false)
    const second = backend.setPolicy(3, true)
    await flush()
    remote.policies[1]!.reply.resolve({ ok: true, value: { ok: true, policy: { revision: 2, autoSettleAfterDays: 3, keepUnacknowledgedFailures: true } } })
    await second
    remote.policies[0]!.reply.resolve({ ok: true, value: { ok: true, policy: { revision: 1, autoSettleAfterDays: 5, keepUnacknowledgedFailures: false } } })
    await first
    expect(backend.state.getSnapshot().policy).toEqual({ revision: 2, autoSettleAfterDays: 3, keepUnacknowledgedFailures: true })
    // A delta published before the second write arrives late: still revision 2.
    remote.stream.push(delta('e1', 1, [], { revision: 1, autoSettleAfterDays: 5, keepUnacknowledgedFailures: false }))
    await flush()
    expect(backend.state.getSnapshot().policy.revision).toBe(2)
  })

  it('resynchronizes when a policy reply contradicts the same revision', async () => {
    const backend = start()
    await ready(backend)
    const write = backend.setPolicy(5, false)
    await flush()
    remote.policies[0]!.reply.resolve({ ok: true, value: { ok: true, policy: { revision: 0, autoSettleAfterDays: 30, keepUnacknowledgedFailures: true } } })
    await write
    expect(backend.state.getSnapshot()).toMatchObject({ status: 'stale', policy: POLICY })
    expect(remote.streams).toHaveLength(2)
  })

  it('ignores a policy reply of a previous generation', async () => {
    const backend = start()
    await ready(backend)
    const write = backend.setPolicy(5, false)
    await flush()
    resets.fire()
    remote.stream.push(baseline('e2', 0, [], POLICY))
    await flush()
    remote.policies[0]!.reply.resolve({ ok: true, value: { ok: true, policy: { revision: 1, autoSettleAfterDays: 5, keepUnacknowledgedFailures: false } } })
    await write
    expect(backend.state.getSnapshot().policy).toEqual(POLICY)
  })

  it('writes nothing after dispose: late RPC replies, stream events and retry timers', async () => {
    vi.useFakeTimers()
    const backend = start()
    remote.stream.push(baseline('e1', 0, [taskView('s1', 1)]))
    await flush()
    const command = backend.command('s1', { kind: 'settle' }, context)
    const policy = backend.setPolicy(5, false)
    await flush()
    remote.stream.end() // stream failure: a backoff retry is scheduled
    await flush()
    expect(vi.getTimerCount()).toBe(1)
    const before = backend.state.getSnapshot()
    const listener = vi.fn()
    backend.state.subscribe(listener)

    backend.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await flush()
    expect(unmounts).toBe(1)
    expect(resets.listeners.size).toBe(0)
    remote.commands[0]!.reply.resolve({ ok: true, value: { ok: true, task: taskView('s1', 2, 'settled'), dataRevision: 1, replayed: false } })
    remote.policies[0]!.reply.resolve({ ok: true, value: { ok: true, policy: { revision: 1, autoSettleAfterDays: 5, keepUnacknowledgedFailures: false } } })
    await command
    await policy
    resets.fire()
    await vi.runAllTimersAsync()
    expect(listener).not.toHaveBeenCalled()
    expect(backend.state.getSnapshot()).toBe(before)
    expect(remote.streams).toHaveLength(1)
    backend.dispose()
    await flush()
    expect(unmounts).toBe(1)
  })

  it('backs off after repeated stream failures and resets the backoff after a baseline', async () => {
    vi.useFakeTimers()
    const backend = start(snapshot('e1', 0), attempt => 1000 * 2 ** attempt)
    remote.stream.end(new Error('disconnected'))
    await flush()
    expect(backend.state.getSnapshot().status).toBe('stale')
    await vi.advanceTimersByTimeAsync(999)
    expect(remote.streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(remote.streams).toHaveLength(2)
    remote.stream.end(new Error('disconnected'))
    await flush()
    await vi.advanceTimersByTimeAsync(1999)
    expect(remote.streams).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(remote.streams).toHaveLength(3)
    remote.stream.push(baseline('e1', 0))
    await flush()
    resets.fire() // first failure after a baseline: immediate
    expect(remote.streams).toHaveLength(4)
  })

  it('pauses while the namespace is gone and resubscribes on the replacement', async () => {
    const backend = start()
    await ready(backend)
    backend.replaceApi(null)
    expect(backend.state.getSnapshot().status).toBe('stale')
    expect(remote.streams).toHaveLength(1)
    expect(await backend.command('s1', { kind: 'settle' }, context)).toMatchObject({ code: 'BASELINE_PENDING' })
    const replacement = new FakeRemote()
    backend.replaceApi(replacement)
    expect(replacement.streams).toHaveLength(1)
    replacement.stream.push(baseline('e9', 0, [taskView('s1', 1)]))
    await flush()
    expect(backend.state.getSnapshot().status).toBe('ready')
    void backend.command('s1', { kind: 'reopen' }, context)
    await flush()
    expect(replacement.commands).toHaveLength(1)
    expect(remote.commands).toHaveLength(0)
  })
})

describe('HostBackend lost replies', () => {
  it('reports UNCONFIRMED, resubscribes, and resends the same commandId after the baseline', async () => {
    const backend = start()
    await ready(backend)
    const first = backend.command('s1', { kind: 'settle' }, context)
    await flush()
    remote.commands[0]!.reply.reject(new Error('socket closed'))
    expect(await first).toMatchObject({ ok: false, code: 'UNCONFIRMED' })
    expect(backend.state.getSnapshot().status).toBe('stale')
    expect(remote.commands).toHaveLength(1)

    remote.stream.push(baseline('e1', 3, [taskView('s1', 2, 'settled')]))
    await flush()
    expect(remote.commands).toHaveLength(2)
    expect(remote.commands[1]!.input.commandId).toBe(remote.commands[0]!.input.commandId)
    expect(remote.commands[1]!.input.expectedRevision).toBe(1)
    remote.commands[1]!.reply.resolve({ ok: true, value: { ok: true, task: taskView('s1', 2, 'settled'), dataRevision: 1, replayed: true } })
    await flush()
    expect(notices).toEqual([{ kind: 'command', outcome: 'committed', sessionId: 's1' }])
    // Settled: a further baseline does not resend.
    resets.fire()
    remote.stream.push(baseline('e1', 4, [taskView('s1', 2, 'settled')]))
    await flush()
    expect(remote.commands).toHaveLength(2)
  })

  it('reports a recovered command the Host refuses as not applied', async () => {
    const backend = start()
    await ready(backend)
    const first = backend.command('s1', { kind: 'settle' }, context)
    await flush()
    remote.commands[0]!.reply.resolve({ ok: false, error: { code: 'gateway/internal', message: 'transport' } })
    expect(await first).toMatchObject({ code: 'UNCONFIRMED' })
    remote.stream.push(baseline('e1', 3, [taskView('s1', 4)]))
    await flush()
    remote.commands[1]!.reply.resolve({ ok: true, value: { ok: false, code: 'CONFLICT', message: 'task changed', task: taskView('s1', 4) } })
    await flush()
    expect(notices).toEqual([{ kind: 'command', outcome: 'not-applied', sessionId: 's1', code: 'CONFLICT' }])
  })

  it('does not track background commands for recovery', async () => {
    const backend = start()
    await ready(backend)
    const wake = backend.command('s1', { kind: 'reopen' }, { ...context, background: true })
    await flush()
    remote.commands[0]!.reply.reject(new Error('socket closed'))
    expect(await wake).toMatchObject({ code: 'UNCONFIRMED' })
    remote.stream.push(baseline('e1', 3, [taskView('s1', 1)]))
    await flush()
    expect(remote.commands).toHaveLength(1)
  })

  it('treats a rejected-before-dispatch request as certainly not applied', async () => {
    const backend = start()
    await ready(backend)
    const result = backend.command('s1', { kind: 'settle' }, context)
    await flush()
    remote.commands[0]!.reply.resolve({ ok: false, error: { code: 'gateway/bad-request', message: 'bad input' } })
    expect(await result).toMatchObject({ ok: false, code: 'PROTOCOL_MISMATCH' })
    expect(backend.state.getSnapshot().status).toBe('ready')
  })

  it('gives up after repeated unconfirmed retries', async () => {
    const backend = start()
    await ready(backend)
    void backend.command('s1', { kind: 'settle' }, context)
    for (let round = 0; round < 6; round++) {
      await flush()
      remote.commands.at(-1)!.reply.reject(new Error('socket closed'))
      await flush()
      remote.stream.push(baseline('e1', round, [taskView('s1', 1)]))
    }
    await flush()
    expect(notices).toEqual([{ kind: 'command', outcome: 'gave-up', sessionId: 's1' }])
    expect(remote.commands).toHaveLength(6)
  })

  it.each([
    ['committed', { revision: 1, autoSettleAfterDays: 3, keepUnacknowledgedFailures: true }],
    ['not-applied', POLICY],
    ['superseded', { revision: 1, autoSettleAfterDays: 30, keepUnacknowledgedFailures: false }],
  ] as const)('settles a lost policy reply from the next baseline: %s', async (outcome, policy) => {
    const backend = start()
    await ready(backend)
    const write = backend.setPolicy(3, true)
    await flush()
    remote.policies[0]!.reply.reject(new Error('socket closed'))
    expect(await write).toMatchObject({ ok: false, code: 'UNCONFIRMED' })
    remote.stream.push(baseline('e1', 1, [], policy))
    await flush()
    expect(notices).toEqual([{ kind: 'policy', outcome }])
    expect(remote.policies).toHaveLength(1) // policy writes are never resent automatically
    expect(backend.state.getSnapshot().policy).toEqual(policy)
  })
})
