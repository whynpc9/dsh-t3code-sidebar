// End-to-end check of the optional message history search against a real
// Harness web host with the installed plugin and the scripted mock model
// (tests/fixtures/mock-llm.mjs). Use an isolated DSH_HOME and a fresh profile.
// Usage: node tests/e2e/history-search.mjs <url-with-token> <workspace-dir> <out-dir>
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [url, workspace, outDir] = process.argv.slice(2)
await mkdir(outDir, { recursive: true })
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
const results = []
const errors = []

function record(id, pass, detail) {
  results.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${detail ?? ''}`)
}

async function waitFor(fn, timeoutMs = 30000, stepMs = 500) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) return null
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
}

async function viewOption(page, label) {
  await page.getByTestId('t3-view-options').click()
  await page.getByRole('menuitem', { name: label }).click()
  await page.waitForTimeout(300)
}

async function startSession(page, prompt) {
  await viewOption(page, 'Workspace')
  const group = page.locator('[data-workspace]:not([data-workspace=""]) .t3sb-group-row').first()
  await group.hover()
  await group.getByRole('button', { name: /^New session in/ }).click()
  const editor = page.getByLabel('Describe what you want to build, / commands, @ files or sessions')
  await editor.waitFor({ timeout: 15000 })
  await editor.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
  const id = await waitFor(() => page.evaluate(() => {
    const row = document.querySelector('.t3sb-session-row[aria-selected="true"]')
    return row !== null && row.querySelector('.t3sb-time') !== null ? row.getAttribute('data-session-id') : null
  }), 15000)
  await viewOption(page, 'Status')
  return id
}

const setPrefs = (page, patch) => page.evaluate((value) => {
  const key = 't3-sidebar:v1:prefs'
  localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), ...value }))
}, patch)

/** Type a query and wait until the search settles (no pending, no indexing). */
async function search(page, query) {
  const input = page.locator('.t3sb-search-input')
  if (!await input.isVisible()) await page.getByTestId('t3-search').click()
  await input.fill(query)
  await page.waitForTimeout(400)
  await waitFor(async () => await page.locator('[aria-label="Searching session history…"]').count() === 0
    && await page.locator('[data-testid="t3-search-indexing"]').count() === 0, 30000, 250)
  return await page.evaluate(() => [...document.querySelectorAll('.t3sb-search-row')].map(row => ({
    id: row.getAttribute('data-session-id'),
    snippet: row.querySelector('.t3sb-search-snippet')?.textContent ?? null,
    mark: row.querySelector('.t3sb-search-mark')?.textContent ?? null,
  })))
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  page.on('pageerror', e => errors.push(e.message))
  // Failed requests are reported with their URL (the console line has none).
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text().slice(0, 300)) })
  page.on('response', (response) => {
    // The native open-in-app menu asks for an icon this Linux host does not serve.
    if (response.status() >= 400 && !response.url().includes('/open-in-app/icon/')) errors.push(`${response.status()} ${response.url().replace(/token=[^&]+/, 'token=…')}`)
  })
  await page.goto(url)
  await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 })
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})

  await viewOption(page, 'Workspace')
  if (await page.locator('[data-workspace]:not([data-workspace=""])').count() === 0) {
    await page.getByTestId('t3-add-workspace').click()
    await page.getByLabel('Folder path on the host').fill(workspace)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.waitForTimeout(1000)
  }
  await viewOption(page, 'Status')

  const plain = await startSession(page, 'Plan the Zebra-Needle migration 中文测试 please')
  const tool = await startSession(page, 'Run #bash for me')
  record('H00.sessions', plain !== null && tool !== null, `${plain} ${tool}`)
  // Let both turns finish (mock replies within a few seconds).
  await page.waitForTimeout(8000)

  // Off by default: the built-in search is used.
  const before = await search(page, 'zebra-needle')
  record('H01.off-by-default', await page.locator('.t3sb-search-input').getAttribute('placeholder') === 'Search session names',
    JSON.stringify(before))

  await setPrefs(page, { historySearch: true })
  await page.reload()
  await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 })
  await page.waitForTimeout(1500)
  record('H02.placeholder', await page.locator('.t3sb-search-input').getAttribute('placeholder') === 'Search sessions and messages')

  const user = await search(page, 'ZEBRA-needle')
  await page.screenshot({ path: join(outDir, 'history-search.png') })
  record('H03.user-text', user.some(hit => hit.id === plain && hit.mark?.toLowerCase() === 'zebra-needle'), JSON.stringify(user))
  const cjk = await search(page, '中文')
  record('H04.cjk-two-chars', cjk.some(hit => hit.id === plain && hit.mark === '中文'), JSON.stringify(cjk))
  // Traditional characters find the simplified text the session holds.
  const variant = await search(page, '測試')
  record('H04b.traditional-finds-simplified', variant.some(hit => hit.id === plain && hit.mark === '测试'), JSON.stringify(variant))
  const reply = await search(page, 'fixture reply')
  record('H05.assistant-text', reply.some(hit => hit.id === plain && hit.mark?.toLowerCase() === 'fixture reply'), JSON.stringify(reply))
  // The tool call's command and its result are never indexed.
  const canary = await search(page, 'sidebar-fixture')
  record('H06.tool-text-excluded', canary.every(hit => hit.id !== tool || hit.mark === null), JSON.stringify(canary))

  // A new message is searchable without a reload.
  await page.locator('.t3sb-search-input').fill('')
  await page.keyboard.press('Escape')
  await page.locator(`[data-section] [data-session-id="${plain}"]`).click()
  const editor = page.getByLabel(/Describe what you want to build|Ask for follow-up changes|Message/).first()
  await editor.click().catch(() => {})
  await page.keyboard.type('Follow-up about quokka-lantern')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(3000)
  const live = await waitFor(async () => {
    const hits = await search(page, 'quokka-lantern')
    return hits.some(hit => hit.id === plain) ? hits : null
  }, 30000, 2000)
  record('H07.new-message', live !== null, JSON.stringify(live))
  record('H99.no-page-errors', errors.length === 0, errors.join(' | '))
} catch (error) {
  record('H99.exception', false, String(error?.stack ?? error))
} finally {
  await writeFile(join(outDir, 'history-search.json'), JSON.stringify({ results, errors }, null, 2))
  await browser.close()
}
process.exit(results.every(result => result.pass) ? 0 : 1)
