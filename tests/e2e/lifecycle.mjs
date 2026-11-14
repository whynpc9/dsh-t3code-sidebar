// Q03 against a fresh Harness Web profile with both tarballs on the Host's disk.
// Usage: node tests/e2e/lifecycle.mjs <host-log> <old-tgz> <new-tgz> <rival-tgz> <report.json>
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { hostUrl, launchChromium, rpc } from './harness-web.mjs'

const [hostLog, previous, candidate, rivalTarball, reportPath] = process.argv.slice(2)
const bundle = 'dsh-t3code-sidebar'
const rival = 'dsh-t3code-slot-rival-fixture'
const url = await hostUrl(hostLog)
const browser = await launchChromium()
const results = { steps: [], cycles: [], errors: [] }

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  page.on('pageerror', error => results.errors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const detail = message.text().replace(/token=[^\s&]+/g, 'token=…')
    if (detail.includes('t3code-sidebar') || detail.includes('web boot')) results.errors.push(detail)
  })
  const streams = new Set()
  page.on('websocket', socket => {
    if (!socket.url().includes('/api/remote.mux')) return
    const active = new Set()
    const closeStream = id => { active.delete(id); streams.delete(id) }
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return
      const frame = JSON.parse(payload)
      if (frame.type === 'open' && frame.endpoint === 't3Sidebar/follow') {
        active.add(frame.streamId)
        streams.add(frame.streamId)
      }
      if (frame.type === 'cancel') closeStream(frame.streamId)
    })
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return
      const frame = JSON.parse(payload)
      if (frame.type === 'end' || frame.type === 'error') closeStream(frame.streamId)
    })
    socket.on('close', () => { for (const id of active) streams.delete(id) })
  })

  const waitForStreams = async expected => {
    const deadline = Date.now() + 10000
    while (streams.size !== expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(streams.size, expected, 'plugin follow streams')
  }
  const count = async () => {
    await cdp.send('HeapProfiler.collectGarbage')
    const { metrics } = await cdp.send('Performance.getMetrics')
    const memory = Object.fromEntries(metrics.filter(metric => ['JSHeapUsedSize', 'Nodes', 'JSEventListeners', 'Documents'].includes(metric.name)).map(metric => [metric.name, metric.value]))
    return {
      ...memory,
      ...await page.evaluate(() => ({
        sidebars: document.querySelectorAll('[data-t3-sidebar]').length,
        pluginRows: document.querySelectorAll('.t3sb-session-row').length,
        pluginStyles: document.querySelectorAll('style[data-plugin="dsh-t3code-sidebar"]').length,
        nativeBrowsers: document.querySelectorAll('[class*="bhn1Oq_root"]').length,
      })),
      pluginStreams: streams.size,
    }
  }
  const completed = (step, details = {}) => {
    results.steps.push({ step, ...details })
    console.log('PASS', step)
  }
  const plug = (method, args) => rpc(page, `pluginManager/${method}`, args)
  const snapshot = () => rpc(page, 't3Sidebar/getSnapshot', { t3ProtocolVersion: 1 })
  const sidebar = page.locator('[data-t3-sidebar]')
  const hostSidebar = page.locator('[data-t3-sidebar][data-backend="host"]')
  const native = page.locator('[class*="bhn1Oq_root"]')
  const checkChange = (result, options = {}) => {
    assert.equal(result.application, 'applied', JSON.stringify(result.error ?? result))
    for (const [key, value] of Object.entries(options)) assert.equal(result[key], value, key)
  }
  const install = async (spec, options = {}) => {
    // The published manager expects both arguments, even when options are empty.
    checkChange(await plug('installBundle', { spec, options }))
    // Package replacement changes the browser module graph. Open a fresh document
    // on the same running Host to verify the newly installed bundle bytes.
    await page.reload()
  }
  const setEnabled = async (name, enabled) => {
    checkChange(await plug('setBundleEnabled', { name, enabled }), { target: name, enabled })
  }
  const assertNative = async () => {
    await native.first().waitFor()
    assert.equal(await sidebar.count(), 0)
    await waitForStreams(0)
  }
  const assertInstalledVersion = async version => {
    await hostSidebar.waitFor()
    const info = (await plug('listBundles')).find(item => item.name === bundle)
    assert.equal(info?.version, version)
    await waitForStreams(1)
  }
  const setTask = (sessionId, expectedRevision, action, commandId = randomUUID()) =>
    rpc(page, 't3Sidebar/command', { t3CommandInput: { protocolVersion: 1, sessionId, expectedRevision, commandId, action, observedPending: [] } })

  await page.goto(url)
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 2500 }).catch(() => {})
  await assertNative()
  await install(previous)
  await assertInstalledVersion('0.1.0-alpha.1')
  completed('install previous tgz from clean profile')

  const { sessionId } = await rpc(page, 'session/create', { request: {} })
  await rpc(page, 'session/prompt', { request: {
    sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Q03 persistence fixture' }],
  } })
  assert.equal((await rpc(page, 'session/wait', { request: { sessionId, timeoutMs: 10000 } })).reason, 'idle')
  // Host task projection can commit the turn end just after session/wait returns.
  const task = async () => (await snapshot()).tasks.find(task => task.sessionId === sessionId)?.record
  const deadline = Date.now() + 10000
  for (;;) {
    if ((await task())?.activity.lastTurnEnd != null) break
    assert(Date.now() < deadline, 'completed turn was not projected')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const parked = await setTask(sessionId, (await task()).revision, { kind: 'snooze', until: Date.now() + 3_600_000 })
  assert(parked.ok, parked.code)
  const original = parked.task.record
  const assertData = async () => {
    const task = (await snapshot()).tasks.find(task => task.sessionId === sessionId)
    assert.deepEqual(task?.record.disposition, original.disposition)
    assert.equal(task.record.revision, original.revision)
    const sessions = await rpc(page, 'session/list', { _request: {} })
    assert(sessions.items.some(session => session.sessionId === sessionId), 'native session survived')
  }
  await assertData()
  completed('park a real mock-backed session and verify persisted state')

  await install(candidate)
  await assertInstalledVersion('0.1.0-alpha.2')
  await assertData()
  completed('upgrade in place and preserve task and conversation')

  const invalidCommandId = randomUUID()
  const stale = await setTask(sessionId, 0, { kind: 'reopen' }, invalidCommandId)
  assert.equal(stale.code, 'CONFLICT')
  await assertData()
  completed('reject stale mutation and retain data')

  await page.evaluate(() => {
    const key = 't3-sidebar:v1:prefs'
    const prefs = JSON.parse(localStorage.getItem(key) ?? '{}')
    prefs.collapsed = { ...prefs.collapsed, 'status:snoozed': false }
    localStorage.setItem(key, JSON.stringify(prefs))
  })
  await page.reload()
  await assertInstalledVersion('0.1.0-alpha.2')
  const parkedRow = sidebar.locator(`[data-section="snoozed"] [data-session-id="${sessionId}"]`)
  await parkedRow.waitFor()

  const enabled = []
  const disabled = []
  for (let cycle = 1; cycle <= 20; cycle += 1) {
    console.log('RUN cycle', cycle)
    await setEnabled(bundle, false)
    await assertNative()
    disabled.push(await count())
    await setEnabled(bundle, true)
    await assertInstalledVersion('0.1.0-alpha.2')
    assert.equal(await native.count(), 0)
    await parkedRow.waitFor()
    await assertData()
    enabled.push(await count())
    results.cycles.push({ cycle, disabled: disabled.at(-1), enabled: enabled.at(-1) })
    console.log('PASS cycle', cycle)
  }
  assert(disabled.every(sample => sample.sidebars === 0 && sample.pluginRows === 0 && sample.pluginStyles === 0 && sample.pluginStreams === 0))
  assert(enabled.every(sample => sample.sidebars === 1 && sample.pluginRows >= 1 && sample.pluginStyles === 1 && sample.pluginStreams === 1))
  completed('20 real Loader disable and enable cycles')

  await install(previous)
  await assertInstalledVersion('0.1.0-alpha.1')
  await assertData()
  completed('roll back in place and preserve task and conversation')

  checkChange(await plug('removeBundle', { name: bundle }))
  await page.reload()
  await assertNative()
  assert((await rpc(page, 'session/list', { _request: {} })).items.some(session => session.sessionId === sessionId))
  await assert.rejects(snapshot, /HTTP (404|500)|method-not-found|not available/)
  completed('uninstall restores native sidebar and removes plugin Remote')

  await install(candidate)
  await assertInstalledVersion('0.1.0-alpha.2')
  await assertData()
  completed('reinstall restores persisted state')

  await install(rivalTarball)
  await page.getByTestId('q03-slot-rival').waitFor()
  assert.equal(await sidebar.count(), 0)
  await setEnabled(rival, false)
  await hostSidebar.waitFor()
  await assertData()
  completed('higher-priority slot wins and disabling it restores sidebar')

  // Control for memory retained by the Harness reload path itself. The
  // sidebar stays disabled and only the small test slot is toggled.
  await setEnabled(bundle, false)
  await assertNative()
  results.controlCycles = []
  for (let cycle = 1; cycle <= 20; cycle += 1) {
    await setEnabled(rival, true)
    await page.getByTestId('q03-slot-rival').waitFor()
    const enabledSample = await count()
    await setEnabled(rival, false)
    await assertNative()
    results.controlCycles.push({ cycle, enabled: enabledSample, disabled: await count() })
  }
  completed('20 Loader control cycles with only the rival fixture')

  assert.deepEqual(results.errors, [])
} catch (error) {
  results.failure = error.message
  const pages = browser.contexts().flatMap(context => context.pages())
  const page = pages[0]
  if (page !== undefined) {
    results.failureState = await page.evaluate(() => ({
      backend: document.querySelector('[data-t3-sidebar]')?.getAttribute('data-backend'),
      native: document.querySelectorAll('[class*="bhn1Oq_root"]').length,
      styles: document.querySelectorAll('style[data-plugin="dsh-t3code-sidebar"]').length,
    })).catch(() => null)
  }
  throw error
} finally {
  await browser.close()
  await writeFile(reportPath, JSON.stringify(results, null, 2) + '\n')
}
