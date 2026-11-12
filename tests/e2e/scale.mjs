// Q02 scale measurements against a Harness web host whose profile was seeded
// with tests/e2e/scale-seed.mjs (100 workspaces × 50 sessions). Timings are
// taken inside the page (performance.now() from the triggering click to the
// first animation frame after the DOM shows the result), so they exclude
// Playwright round trips but include the Host round trip where one exists.
// Usage: node tests/e2e/scale.mjs <url-with-token> <out-dir> [activeTurns=0]
//   activeTurns > 0 also starts that many slow turns (mock "#slow") first.
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [url, outDir, activeArg = '0'] = process.argv.slice(2)
const activeTurns = Number(activeArg)
await mkdir(outDir, { recursive: true })
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
const report = { at: new Date().toISOString(), url: url.replace(/token=[^&]+/, 'token=…'), activeTurns, metrics: {}, samples: {}, errors: [] }

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

async function waitFor(fn, timeoutMs = 60000, stepMs = 250) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) return null
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
}

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
// In-page bounded wait: resolves true when the predicate holds on an animation frame, false after the timeout.
await context.addInitScript(() => {
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

// ── First screen: navigation → sidebar with rows and a ready Host baseline ──
const navigationStart = Date.now()
await page.goto(url)
await page.waitForSelector('[data-t3-sidebar][data-backend="host"] .t3sb-session-row', { timeout: 120000 })
report.metrics.firstRowsMs = Date.now() - navigationStart
report.metrics.firstRowsNote = 'navigation to first task rows with the Host backend; includes page load and the Host catalog/baseline'
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
  await viewOption('Workspace')
  for (let i = 0; i < activeTurns; i += 1) {
    const group = page.locator('[data-workspace]:not([data-workspace=""]) .t3sb-group-row').first()
    await group.hover()
    await group.getByRole('button', { name: /^New session in/ }).click()
    const editor = page.getByLabel(/Describe what you want to build|Message or run a task/).first()
    await editor.waitFor({ timeout: 15000 })
    await editor.click()
    await page.keyboard.type(`load ${i} #slow`)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
  }
  await viewOption('Status')
  const working = await waitFor(async () => {
    const n = await page.evaluate(() => document.querySelectorAll('[data-section="working"] .t3sb-session-row').length)
    return n >= activeTurns ? n : null
  }, 120000)
  report.metrics.workingRows = working ?? await page.evaluate(() => document.querySelectorAll('[data-section="working"] .t3sb-session-row').length)
  report.metrics.withActive = await counts()
  report.metrics.heapWithActiveMb = await heapMb()
}

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
report.metrics.flatView = await page.evaluate(() => ({ sessionRows: document.querySelectorAll('.t3sb-session-row').length }))
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
// ── Semantic updates: Settle / Unsettle round trips through the Host ──
// Keep the Settled section open (it is collapsed by default) so moved rows stay visible.
await page.evaluate(() => {
  const prefs = JSON.parse(localStorage.getItem('t3-sidebar:v1:prefs') ?? '{}')
  prefs.collapsed = { ...(prefs.collapsed ?? {}), 'status:settled': false, 'status:active': false }
  localStorage.setItem('t3-sidebar:v1:prefs', JSON.stringify(prefs))
})
await page.reload()
await page.waitForSelector('[data-t3-sidebar][data-backend="host"] .t3sb-session-row', { timeout: 120000 })
await page.waitForTimeout(2000)
const updates = []
const timedClick = (selector, landed) => page.evaluate(async ({ selector, landed }) => {
  const button = document.querySelector(selector)
  if (button === null) return -1
  const start = performance.now()
  button.click()
  if (!await window.__until(() => document.querySelector(landed) !== null)) return -1
  await new Promise(resolve => requestAnimationFrame(() => resolve()))
  return performance.now() - start
}, { selector, landed })
for (let i = 0; i < 10; i += 1) {
  // Row actions render while the row is hovered, as in the native browser.
  const id = await page.evaluate(() => [...document.querySelectorAll('[data-section="active"] .t3sb-session-row')]
    .map(row => row.getAttribute('data-session-id')).find(candidate => !document.querySelector(`[data-session-id="${candidate}"]`)?.classList.contains('t3sb-selected')) ?? null)
  if (id === null) break
  await page.locator(`[data-section="active"] [data-session-id="${id}"]`).hover()
  const settle = await timedClick(`[data-section="active"] [data-session-id="${id}"] button[data-action="settle"]`, `[data-section="settled"] [data-session-id="${id}"]`)
  updates.push(settle)
  if (settle < 0) break
  await page.locator(`[data-section="settled"] [data-session-id="${id}"]`).hover()
  updates.push(await timedClick(`[data-section="settled"] [data-session-id="${id}"] button[data-action="unsettle"]`, `[data-section="active"] [data-session-id="${id}"]`))
  await page.mouse.move(900, 600)
  await page.waitForTimeout(300)
}
report.samples.semanticUpdateMs = updates.map(Math.round)
report.metrics.semanticUpdate = updates.length > 0 ? summary(updates) : null
report.metrics.semanticUpdateNote = 'click → row in its new section, including the Host command round trip and the follow delta'

progress('reloads')
// ── Reload cycles: heap after each fresh load stays bounded ──
const reloads = []
for (let i = 0; i < 5; i += 1) {
  const start = Date.now()
  await page.reload()
  await page.waitForSelector('[data-t3-sidebar][data-backend="host"] .t3sb-session-row', { timeout: 120000 })
  reloads.push({ firstRowsMs: Date.now() - start, heapMb: await heapMb() })
}
report.samples.reloads = reloads
report.metrics.heapFinalMb = await heapMb()
report.metrics.final = await counts()
await page.screenshot({ path: join(outDir, `scale-${activeTurns > 0 ? 'active' : 'idle'}.png`) })

await writeFile(join(outDir, `scale-${activeTurns > 0 ? 'active' : 'idle'}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report.metrics, null, 2))
await browser.close()
