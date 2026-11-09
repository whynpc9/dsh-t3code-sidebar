// End-to-end scenario against a real Harness web host with the installed
// plugin and the scripted mock model (tests/fixtures/mock-llm.mjs).
// Usage: node tests/e2e/scenario.mjs <url-with-token> <workspace-dir> <out-dir> [phase]
//   phase "main"    (default) – create sessions, park them, check two windows
//   phase "restart" – after a Host restart, check that parking survived
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [url, workspace, outDir, phase = 'main'] = process.argv.slice(2)
await mkdir(outDir, { recursive: true })
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
const results = []
const errors = []

function record(id, pass, detail) {
  results.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${detail ?? ''}`)
}

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
  await page.goto(url)
  await page.waitForSelector('[data-t3-sidebar="tasks"],[data-t3-sidebar="projects"]', { timeout: 30000 })
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})
  return page
}

const counts = page => page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('[data-section]')].map(s => [s.getAttribute('data-section'), Number(s.querySelector('.t3sb-count')?.textContent ?? '0')]),
))

const sectionOf = (page, sessionId) => page.evaluate((id) => {
  const row = document.querySelector(`[data-section] [data-session-id="${CSS.escape(id)}"]`)
  return row === null ? null : { section: row.closest('[data-section]').getAttribute('data-section'), status: row.getAttribute('data-status') }
}, sessionId)

async function waitFor(fn, timeoutMs = 30000, stepMs = 500) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) return null
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
}

async function expandAll(page) {
  for (let guard = 0; guard < 10; guard += 1) {
    const collapsed = page.locator('[data-section] > .t3sb-section-header[aria-expanded="false"]')
    if (await collapsed.count() === 0) return
    await collapsed.first().click()
  }
}

/** Start a session in the first project, send a prompt, return its id. */
async function startSession(page, prompt) {
  await page.getByTestId('t3-view-projects').click()
  await page.locator('[data-project] button[aria-label^="New session in"]').first().click()
  const editor = page.getByLabel('Describe what you want to build, / commands, @ files or sessions')
  await editor.waitFor({ timeout: 15000 })
  await editor.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
  const id = await waitFor(() => page.evaluate(() => document.querySelector('.t3sb-row[aria-current="true"]')?.getAttribute('data-session-id') ?? null), 15000)
  await page.getByTestId('t3-view-tasks').click()
  return id
}

async function menuAction(page, sessionId, path) {
  await page.locator(`[data-section] [data-session-id="${sessionId}"] .t3sb-row-main`).click({ button: 'right' })
  for (const [index, label] of path.entries()) {
    const item = page.getByRole('menuitem', { name: label, exact: true })
    await item.waitFor({ timeout: 5000 })
    if (index < path.length - 1) { await item.hover(); await item.click().catch(() => {}) } else await item.click()
  }
}

try {
  if (phase === 'main') {
    const page = await openPage()
    // F08: add a project through the plugin's own flow.
    await page.getByTestId('t3-view-projects').click()
    if (await page.locator('[data-project]:not([data-project="ungrouped"])').count() === 0) {
      await page.getByTestId('t3-add-project').click()
      await page.getByLabel('Folder path on the host').fill(workspace)
      await page.getByRole('button', { name: 'Add', exact: true }).click()
    }
    record('F08.add-project', await waitFor(() => page.locator('[data-project]:not([data-project="ungrouped"])').count(), 10000) !== null)

    const done = await startSession(page, 'quick question')
    const slow = await startSession(page, 'long job #slow')
    const workingWhileRunning = await waitFor(async () => (await sectionOf(page, slow))?.section === 'working', 20000)
    record('A02.working-while-running', workingWhileRunning !== null, JSON.stringify(await sectionOf(page, slow)))
    await page.screenshot({ path: join(outDir, '01-working.png') })

    const failed = await startSession(page, 'broken job #fail')
    await expandAll(page)
    const doneState = await waitFor(async () => { const s = await sectionOf(page, done); return s?.section === 'active' ? s : null }, 30000)
    record('A02.completed-returns-active', doneState !== null, JSON.stringify(doneState))
    const failedState = await waitFor(async () => { const s = await sectionOf(page, failed); return s?.status === 'failed' ? s : null }, 60000)
    record('F03.failure-visible', failedState !== null, JSON.stringify(await sectionOf(page, failed)))

    const bash = await startSession(page, 'tool job #bash')
    await expandAll(page)
    const bashState = await waitFor(async () => { const s = await sectionOf(page, bash); return s !== null && s.status !== 'running' ? s : null }, 30000)
    record('F03.tool-turn-observed', bashState !== null, JSON.stringify(bashState))
    await page.screenshot({ path: join(outDir, '02-states.png') })

    // F04: snooze through the native session menu (plugin contribution).
    await menuAction(page, done, ['Snooze', 'In 1 hour'])
    const snoozed = await waitFor(async () => (await sectionOf(page, done))?.section === 'snoozed', 10000)
    record('F04.snooze', snoozed !== null, JSON.stringify(await sectionOf(page, done)))

    // F05: settle the failed (idle) session; refuse settling the running one.
    if (failedState !== null) {
      await menuAction(page, failed, ['Mark handled'])
      const settled = await waitFor(async () => (await sectionOf(page, failed))?.section === 'settled', 10000)
      record('F05.manual-settle', settled !== null, JSON.stringify(await sectionOf(page, failed)))
    } else {
      record('F05.manual-settle', false, 'failed session never reached failed state')
    }
    await page.screenshot({ path: join(outDir, '03-parked.png') })

    // A06/A09: a second window converges through the Host follow stream.
    const second = await openPage()
    await expandAll(second)
    const secondState = await waitFor(async () => {
      const a = await sectionOf(second, done)
      const b = await sectionOf(second, failed)
      return a?.section === 'snoozed' && b?.section === 'settled' ? { a, b } : null
    }, 15000)
    record('A06.second-window-baseline', secondState !== null, JSON.stringify(secondState))
    await menuAction(page, failed, ['Reopen'])
    const reopenedRemotely = await waitFor(async () => (await sectionOf(second, failed))?.section === 'active', 10000)
    record('A06.second-window-delta', reopenedRemotely !== null, JSON.stringify(await sectionOf(second, failed)))
    // Re-settle so the restart phase has one of each.
    await menuAction(page, failed, ['Mark handled'])
    await waitFor(async () => (await sectionOf(page, failed))?.section === 'settled', 10000)

    // F01: view switch keeps state; reload keeps the view preference.
    await page.getByTestId('t3-view-projects').click()
    await page.reload()
    await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 })
    const view = await page.locator('[data-t3-sidebar]').getAttribute('data-t3-sidebar')
    record('F01.view-remembered', view === 'projects', view)
    await page.getByTestId('t3-view-tasks').click()

    // A11 partial: the native browser stays hidden while the plugin renders.
    record('A11.single-winner', await page.locator('[class*="bhn1Oq_root"]').count() === 0)
    await writeFile(join(outDir, 'sessions.json'), JSON.stringify({ done, slow, failed, bash }, null, 2))
  } else {
    const ids = JSON.parse(await (await import('node:fs/promises')).readFile(join(outDir, 'sessions.json'), 'utf8'))
    const page = await openPage()
    await expandAll(page)
    const survived = await waitFor(async () => {
      const a = await sectionOf(page, ids.done)
      const b = await sectionOf(page, ids.failed)
      return a?.section === 'snoozed' && b?.section === 'settled' ? { a, b } : null
    }, 20000)
    record('A04.host-restart-keeps-parking', survived !== null, JSON.stringify(survived ?? { done: await sectionOf(page, ids.done), failed: await sectionOf(page, ids.failed) }))
    await page.screenshot({ path: join(outDir, '04-after-restart.png') })
  }
} catch (error) {
  record('scenario.exception', false, error instanceof Error ? error.stack?.slice(0, 600) : String(error))
} finally {
  await writeFile(join(outDir, `results-${phase}.json`), JSON.stringify({ phase, at: new Date().toISOString(), results, errors: errors.slice(0, 20) }, null, 2))
  await browser.close()
}
