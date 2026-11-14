// Q02 measurements on a real Harness web profile seeded with scale-seed.mjs.
// Usage: node tests/e2e/scale.mjs <host-log> <out-dir> [activeTurns=0]
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchChromium, rpc, hostUrl } from './harness-web.mjs'

const [hostLog, outDir, activeArg = '0'] = process.argv.slice(2)
const url = await hostUrl(hostLog)
const activeTurns = Number(activeArg)
await mkdir(outDir, { recursive: true })
const browser = await launchChromium()
const report = { at: new Date().toISOString(), activeTurns, metrics: {}, samples: {}, errors: [] }

/** Nearest-rank percentile. */
const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))]
}
const summary = (all) => {
  const values = all.filter(value => value >= 0)
  return { timeouts: all.length - values.length, ...summaryOf(values) }
}
const summaryOf = values => values.length === 0 ? { n: 0 } : ({ n: values.length, p50: Math.round(percentile(values, 0.5)), p95: Math.round(percentile(values, 0.95)), max: Math.round(Math.max(...values)) })

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  // In-page bounded wait: resolves true when the predicate holds on an animation frame, false after the timeout.
  await context.addInitScript(() => {
    window.q02Wire = { baselines: {}, deltas: {} }
    // Timestamp inside the browser, before Harness dispatches the received frame.
    const fetch = window.fetch
    window.fetch = async (input, init) => {
      const response = await fetch(input, init)
      const path = new URL(response.url).pathname
      if (path === '/api/session/list' || path === '/api/t3Sidebar/getSnapshot') {
        const json = response.json.bind(response)
        response.json = async () => {
          const value = await json()
          if (value.result?.ok) window.q02Wire.baselines[path] ??= performance.now()
          return value
        }
      }
      return response
    }
    const streams = new Map()
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function (payload) {
      if (this.url.includes('/api/remote.mux')) {
        const frame = JSON.parse(payload)
        if (frame.type === 'open') streams.set(frame.streamId, frame.endpoint)
      }
      return send.call(this, payload)
    }
    const NativeSocket = WebSocket
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args)
        if (!this.url.includes('/api/remote.mux')) return
        this.addEventListener('message', ({ data }) => {
          const at = performance.now()
          if (typeof data !== 'string') return
          const frame = JSON.parse(data)
          if (frame.type !== 'item') return
          const endpoint = streams.get(frame.streamId)
          if (endpoint === undefined) return
          if (endpoint === 't3Sidebar/follow' && frame.value?.kind === 'delta') {
            for (const task of frame.value.tasks) window.q02Wire.deltas[task.sessionId] = at
          } else {
            window.q02Wire.baselines[endpoint] ??= at
          }
        })
      }
    }
    window.__until = (predicate, timeoutMs = 15000) => new Promise((resolve) => {
      const deadline = performance.now() + timeoutMs
      const check = () => {
        if (predicate()) resolve(true)
        else if (performance.now() > deadline) resolve(false)
        else requestAnimationFrame(check)
      }
      check()
    })
  })
  const page = await context.newPage()
  const progress = (step) => { console.error(`[scale] ${new Date().toISOString()} ${step}`) }
  page.on('pageerror', e => report.errors.push(e.message))
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  const heapMb = async () => {
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
    const { metrics } = await cdp.send('Performance.getMetrics')
    return Math.round((metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1e5) / 10
  }

  // Both navigation-to-rows and Client-only times are kept.
  async function firstScreen() {
    const duration = await page.evaluate(async () => {
      const hasRows = () => [...document.querySelectorAll('[data-t3-sidebar][data-backend="host"] .t3sb-session-row')]
        .some(row => row.querySelector('.t3sb-time'))
      const endpoints = ['workspace/follow', '/api/session/list', '/api/t3Sidebar/getSnapshot']
      const receipts = () => endpoints.map(endpoint => window.q02Wire.baselines[endpoint])
      if (!await window.__until(() => receipts().every(Number.isFinite) && hasRows(), 30000)) return null
      await new Promise(resolve => requestAnimationFrame(resolve))
      const navigationMs = performance.now()
      return { navigationMs, clientMs: navigationMs - Math.max(...receipts()), receipts: window.q02Wire.baselines }
    })
    assert(duration, 'workspace and session catalogs and plugin baseline rendered in Host mode')
    return duration
  }
  await page.goto(url)
  report.metrics.firstScreen = await firstScreen()
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 2000 }).catch(() => {})
  await page.waitForTimeout(3000)

  const counts = () => page.evaluate(() => ({
    sessionRows: document.querySelectorAll('.t3sb-session-row').length,
    allNodes: document.querySelectorAll('[data-t3-sidebar] *').length,
    sections: Object.fromEntries([...document.querySelectorAll('[data-section]')].map(section => [
      section.getAttribute('data-section'),
      Number(section.querySelector('.t3sb-group-row .t3sb-group-count')?.textContent?.replace(/\D/g, '') || section.querySelectorAll('.t3sb-session-row').length),
    ])),
  }))
  report.metrics.status = await counts()
  report.metrics.heapAfterLoadMb = await heapMb()

  progress('active load')
  // ── Optional load: N concurrently running turns in one workspace ──
  async function viewOption(label) {
    await page.getByTestId('t3-view-options').click()
    await page.getByRole('menuitem', { name: label }).click()
    await page.waitForTimeout(200)
  }
  if (activeTurns > 0) {
    const { items } = await rpc(page, 'session/list', { _request: {} })
    const seeded = items.filter(session => session.cwd?.endsWith('/w000') && !session.blank)
    assert(seeded.length >= activeTurns, `expected ${activeTurns} seeded sessions in w000, got ${seeded.length}`)
    const loadIds = seeded.slice(0, activeTurns).map(session => session.sessionId)
    assert.equal(new Set(loadIds).size, activeTurns)
    await Promise.all(loadIds.map((sessionId, index) => rpc(page, 'session/prompt', { request: {
      sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: `load ${index} #slow` }],
    } })))
    await page.waitForFunction(count => document.querySelectorAll('[data-section="working"] .t3sb-session-row').length === count, activeTurns, { timeout: 90000 })
    report.metrics.withActive = await counts()
    report.metrics.workingRows = report.metrics.withActive.sections.working
    report.metrics.heapWithActiveMb = await heapMb()
  }
  report.metrics.catalogSessions = (await rpc(page, 'session/list', { _request: {} })).items.length

  progress('view switches')
  // ── View switches (status ↔ workspace ↔ flat) ──
  async function timedViewSwitch(label, mode) {
    await page.getByTestId('t3-view-options').click()
    await page.getByRole('menuitem', { name: label }).waitFor()
    return await page.evaluate(async ({ label, mode }) => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(element => element.textContent?.trim() === label)
      const start = performance.now()
      item.click()
      if (!await window.__until(() => document.querySelector(`[data-t3-sidebar="${mode}"]`) !== null)) return -1
      await new Promise(resolve => requestAnimationFrame(() => resolve()))
      return performance.now() - start
    }, { label, mode })
  }
  const switches = []
  for (let i = 0; i < 10; i += 1) {
    switches.push(await timedViewSwitch('Workspace', 'workspace'))
    switches.push(await timedViewSwitch('In one list', 'flat'))
    switches.push(await timedViewSwitch('Status', 'status'))
  }
  report.samples.viewSwitchMs = switches.map(Math.round)
  report.metrics.viewSwitch = summary(switches)
  await viewOption('Workspace')
  report.metrics.workspaceView = await page.evaluate(() => ({
    groups: document.querySelectorAll('[data-workspace]').length,
    sessionRows: document.querySelectorAll('.t3sb-session-row').length,
  }))
  await viewOption('In one list')
  const flat = page.locator('.t3sb-flat-list')
  const flatSamples = []
  for (const fraction of [0, 0.25, 0.5, 0.75, 1, 0.5, 0]) {
    const sample = await flat.evaluate(async (list, fraction) => {
      list.scrollTop = (list.scrollHeight - list.clientHeight) * fraction
      const rows = () => [...list.querySelectorAll('.t3sb-session-row')]
      const visible = () => {
        const viewport = list.getBoundingClientRect()
        return rows().filter(row => {
          const bounds = row.getBoundingClientRect()
          return bounds.bottom > viewport.top && bounds.top < viewport.bottom
        })
      }
      await window.__until(() => visible().length > 0, 1500)
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return {
        fraction, top: list.scrollTop, mounted: rows().length, visible: visible().length,
        first: Number(rows()[0]?.getAttribute('aria-posinset')),
        total: Number(rows()[0]?.getAttribute('aria-setsize')),
      }
    }, fraction)
    assert(sample.visible > 0 && sample.mounted <= sample.visible + 150, JSON.stringify(sample))
    flatSamples.push(sample)
  }
  assert(flatSamples[4].first > 4000, 'scroll reached the end without keeping the preceding rows')
  const position = () => page.evaluate(() => Number(document.activeElement?.getAttribute('aria-posinset')))
  await flat.getByRole('treeitem').first().focus()
  await page.keyboard.press('End')
  assert.equal(await position(), flatSamples[0].total)
  await page.getByRole('button', { name: 'Locate current session' }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-selected') === 'true')
  await page.keyboard.press('Home')
  assert.equal(await position(), 1)
  await page.keyboard.press('ArrowDown')
  assert.equal(await position(), 2)
  report.metrics.flatView = { samples: flatSamples, keyboard: ['End', 'Locate current session', 'Home', 'ArrowDown'], heapAfterScrollingMb: await heapMb() }
  await viewOption('Status')

  progress('title search')
  // ── Title / workspace-name search (instant local matching) ──
  await page.getByTestId('t3-search').click()
  const searches = []
  for (let i = 0; i < 20; i += 1) {
    const query = `w0${String(10 + i).padStart(2, '0')}`
    searches.push(await page.evaluate(async (query) => {
      const input = document.querySelector('.t3sb-search-input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(resolve => requestAnimationFrame(() => resolve()))
      const start = performance.now()
      setter.call(input, query)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      if (!await window.__until(() => document.querySelectorAll('.t3sb-search-row').length > 0)) return -1
      await new Promise(resolve => requestAnimationFrame(() => resolve()))
      return performance.now() - start
    }, query))
  }
  report.samples.titleSearchMs = searches.map(Math.round)
  report.metrics.titleSearch = summary(searches)
  report.metrics.searchRows = await page.evaluate(() => document.querySelectorAll('.t3sb-search-row').length)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  progress('semantic updates')
  // A second tab issues commands. This tab receives follow deltas: elapsed time
  // starts at the frame arrival and excludes the Host command round trip.
  const writer = await context.newPage()
  await writer.goto(url)
  await writer.waitForSelector('[data-t3-sidebar][data-backend="host"] .t3sb-session-row')
  await page.bringToFront()
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('t3-sidebar:v1:prefs') ?? '{}')
    prefs.collapsed = { ...(prefs.collapsed ?? {}), 'status:settled': false, 'status:active': false }
    localStorage.setItem('t3-sidebar:v1:prefs', JSON.stringify(prefs))
  })
  await page.reload()
  await firstScreen()
  const catalog = await rpc(writer, 'session/list', { _request: {} })
  const id = catalog.items.find(session => session.cwd?.endsWith('/w001') && !session.blank)?.sessionId
  assert(id, 'real session in a workspace outside the slow-turn load')
  const requestId = randomUUID()
  await rpc(writer, 'session/prompt', { request: {
    sessionId: id, requestId, mode: 'queue', content: [{ type: 'text', text: 'Q02 semantic sample' }],
  } })
  const finished = await rpc(writer, 'session/wait', { request: { sessionId: id, timeoutMs: 10000 } })
  assert.equal(finished.reason, 'idle')
  await page.locator(`[data-section="active"] [data-session-id="${id}"]`).waitFor()
  // Let the Host's post-turn activity sample settle before sending the first command.
  await page.waitForTimeout(3000)
  let revision = (await rpc(writer, 't3Sidebar/getSnapshot', { t3ProtocolVersion: 1 })).tasks.find(task => task.sessionId === id)?.record.revision ?? 0
  const updates = []
  for (let i = 0; i < 20; i += 1) {
    const settle = i % 2 === 0
    const section = settle ? 'settled' : 'active'
    await page.evaluate(({ id, section }) => {
      delete window.q02Wire.deltas[id]
      const selector = `[data-section="${section}"] [data-session-id="${CSS.escape(id)}"]`
      window.q02Paint = (async () => {
        if (!await window.__until(() => window.q02Wire.deltas[id] !== undefined && document.querySelector(selector))) return -1
        await new Promise(resolve => requestAnimationFrame(resolve))
        return performance.now() - window.q02Wire.deltas[id]
      })()
    }, { id, section })
    const result = await rpc(writer, 't3Sidebar/command', { t3CommandInput: {
      protocolVersion: 1, commandId: randomUUID(), sessionId: id, expectedRevision: revision,
      action: { kind: settle ? 'settle' : 'reopen' }, observedPending: [],
    } })
    assert(result.ok, `semantic operation ${i} failed: ${result.code}`)
    revision = result.task.record.revision
    const update = await page.evaluate(() => window.q02Paint)
    updates.push(update)
  }
  await writer.close()
  report.samples.semanticUpdateMs = updates.map(Math.round)
  report.metrics.semanticUpdate = summary(updates)

  progress('reloads')
  // ── Reload cycles: heap after each fresh load stays bounded ──
  const reloads = []
  for (let i = 0; i < 5; i += 1) {
    await page.reload()
    reloads.push({ ...await firstScreen(), heapMb: await heapMb() })
  }
  report.samples.reloads = reloads
  report.metrics.heapFinalMb = await heapMb()
  report.metrics.final = await counts()
  await page.screenshot({ path: join(outDir, `scale-${activeTurns > 0 ? 'active' : 'idle'}.png`) })

  await writeFile(join(outDir, `scale-${activeTurns > 0 ? 'active' : 'idle'}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report.metrics, null, 2))
  assert([report.metrics.firstScreen, ...report.samples.reloads].every(sample => sample.clientMs < 300), 'first-screen render budget')
  assert.equal(report.errors.length, 0, 'browser errors')
  assert.equal(report.metrics.viewSwitch.timeouts + report.metrics.titleSearch.timeouts + report.metrics.semanticUpdate.timeouts, 0)
  assert(report.metrics.viewSwitch.p95 < 150 && report.metrics.titleSearch.p95 < 100 && report.metrics.semanticUpdate.p95 < 100, 'latency budget')
} finally {
  await browser.close()
}
