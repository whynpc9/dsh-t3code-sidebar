// A10 against a released, isolated Harness Web Host and the access-gate fixture.
// Pass the Host log file so its one-time launch URL stays out of command output.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [log, workspace, mode] = process.argv.slice(2)
assert(log && workspace, 'usage: node tests/e2e/access-gate.mjs <host-log> <isolated-workspace> [host-off]')
const launch = /dsh web: (http\S+)/.exec(await readFile(log, 'utf8'))?.[1]
assert(launch, 'no launch URL in Host log')
const { origin, hostname } = new URL(launch)
assert.equal(hostname, '127.0.0.1', 'use an isolated loopback Web Host')
const handshake = await fetch(launch, { redirect: 'manual' })
assert.equal(handshake.status, 303)
const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
assert(cookie, 'no owner cookie from isolated Host')

async function post(path, data, authenticated = true) {
  return await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...(authenticated ? { cookie } : {}) },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(5000),
  })
}
const fixturePath = '/api/t3-a10-fixture'
async function fixture(input) {
  const response = await post(fixturePath, input)
  assert.equal(response.status, 200, 'fixture transport')
  return await response.json()
}
async function rpc(method, args, viewer = false) {
  const path = '/api/' + method
  const body = { type: 'client-request', rpcId: randomUUID(), method, payload: { args } }
  if (viewer) return (await fixture({ op: 'call', path, body })).result
  const response = await post(path, body)
  assert.equal(response.status, 200, method)
  return (await response.json()).result
}
function value(result) {
  assert.equal(result.ok, true, result.error?.code)
  return result.value
}
function refused(result, code) {
  assert.equal(result.ok, false)
  assert.equal(result.error.code, code)
  assert(!Object.hasOwn(result, 'value'))
}
function pass(check) { console.log(`PASS ${check}`) }

const snapshotArgs = { t3ProtocolVersion: 1 }
if (mode === 'host-off') {
  const response = await post('/api/t3Sidebar/getSnapshot', {
    type: 'client-request', rpcId: randomUUID(), method: 't3Sidebar/getSnapshot', payload: { args: snapshotArgs },
  })
  assert.equal(response.status, 404)
  value(await rpc('session/list', { _request: {} }))
  pass('Host-off returns 404 for task API and native session/list still works')
} else {
  assert.equal((await post(fixturePath, { op: 'dispose' }, false)).status, 401)
  const sessionId = value(await rpc('session/create', { request: { cwd: resolve(workspace) } })).sessionId
  const privateId = value(await rpc('session/create', { request: { cwd: resolve(workspace) } })).sessionId
  const command = (sessionId, expectedRevision, action) =>
    ({ t3CommandInput: { protocolVersion: 1, commandId: randomUUID(), sessionId, expectedRevision, action, observedPending: [] } })
  const parked = value(await rpc('t3Sidebar/command', command(sessionId, 0, { kind: 'settle' })))
  const privateParked = value(await rpc('t3Sidebar/command', command(privateId, 0, { kind: 'settle' })))
  assert.equal(parked.task.record.disposition.kind, 'settled')
  assert.equal(privateParked.task.record.disposition.kind, 'settled')
  const original = value(await rpc('t3Sidebar/getSnapshot', snapshotArgs))
  const policy = {
    t3PolicyInput: { protocolVersion: 1, expectedRevision: original.policy.revision, autoSettleAfterDays: null, keepUnacknowledgedFailures: false },
  }
  const reopen = command(sessionId, parked.task.record.revision, { kind: 'reopen' })
  const open = (id, endpoint, args) => fixture({ op: 'stream-open', id, endpoint, payload: { args } })
  const next = id => fixture({ op: 'stream-next', id })
  const configure = taskGrant => fixture({ op: 'configure', taskGrant, visibleSession: sessionId })

  await configure(false)
  const native = value(await rpc('session/list', { _request: {} }, true))
  assert.deepEqual(native.items.map(item => item.sessionId), [sessionId])
  for (const [method, args] of [
    ['getSnapshot', snapshotArgs], ['listTransitions', { t3Limit: 20 }],
    ['previewPolicy', { t3PreviewInput: { protocolVersion: 1, draft: null } }],
    ['command', reopen], ['setPolicy', policy],
  ]) refused(await rpc('t3Sidebar/' + method, args, true), 'remote-access/denied')
  assert.equal((await open(1, 't3Sidebar/follow', snapshotArgs)).failure.code, 'remote-access/denied')
  pass('guest sees only its native session and Gateway denies all six task endpoints')

  const unknown = [
    { t3CommandInput: { ...reopen.t3CommandInput, futureField: true } },
    { t3CommandInput: { ...reopen.t3CommandInput, action: { kind: 'reopen', futureField: true } } },
    { t3CommandInput: { ...reopen.t3CommandInput, action: { kind: 'future-action' } } },
  ]
  for (const args of unknown) {
    const result = value(await rpc('t3Sidebar/command', args))
    assert.equal(result.code, 'PROTOCOL_MISMATCH')
    assert.equal(result.task, null)
  }
  const invalidPolicy = value(await rpc('t3Sidebar/setPolicy', { t3PolicyInput: { ...policy.t3PolicyInput, futureField: true } }))
  assert.equal(invalidPolicy.code, 'PROTOCOL_MISMATCH')
  const afterInvalid = value(await rpc('t3Sidebar/getSnapshot', snapshotArgs))
  assert.equal(afterInvalid.dataRevision, original.dataRevision)
  assert.equal(afterInvalid.policy.revision, original.policy.revision)
  pass('unknown command/policy fields and unknown action have no persisted effect')

  // A test-only grant permits opening a task stream before taking it away.
  await configure(true)
  assert.equal((await open(2, 'remoteAccess/follow', {})).opened, true)
  assert.equal((await next(2)).value.owner, false)
  assert.equal((await open(3, 't3Sidebar/follow', snapshotArgs)).opened, true)
  assert.equal((await next(3)).value.kind, 'baseline')
  await configure(false)
  const grantChange = (await next(2)).value
  assert.equal(grantChange.type, 'upsert')
  assert(!grantChange.grant.actions.includes('t3Sidebar/getSnapshot'))
  refused(await rpc('t3Sidebar/command', reopen, true), 'remote-access/denied')
  refused(await rpc('t3Sidebar/setPolicy', policy, true), 'remote-access/denied')
  const afterRevoke = value(await rpc('t3Sidebar/getSnapshot', snapshotArgs))
  assert.equal(afterRevoke.dataRevision, original.dataRevision)
  assert.equal(afterRevoke.policy.revision, original.policy.revision)
  const ownerReopen = value(await rpc('t3Sidebar/command', reopen))
  assert.equal(ownerReopen.task.record.disposition.kind, 'normal')
  assert.equal((await next(3)).failure.code, 't3Sidebar/access-denied')
  pass('revocation updates the access stream, denies writes and withholds subsequent task deltas')

  await fixture({ op: 'dispose' })
  refused(await rpc('t3Sidebar/getSnapshot', snapshotArgs, true), 'gateway/peer-disposed')
  assert.equal((await open(4, 't3Sidebar/follow', snapshotArgs)).failure.code, 'gateway/peer-disposed')
  assert.equal(value(await rpc('t3Sidebar/getSnapshot', snapshotArgs)).dataRevision, ownerReopen.dataRevision)
  pass('disposed guest Peer cannot issue RPCs or reopen a stream; owner retains access')
}
