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
  await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 })
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})
  return page
}

const grouping = page => page.locator('[data-t3-sidebar]').getAttribute('data-t3-sidebar')
const sectionKeys = page => page.evaluate(() => [...document.querySelectorAll('[data-section]')].map(s => s.getAttribute('data-section')))

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

/** Pick one entry of the header's view-options menu. */
async function viewOption(page, label) {
  await page.getByTestId('t3-view-options').click()
  await page.getByRole('menuitem', { name: label }).click()
  await page.waitForTimeout(300)
}

async function expandAll(page) {
  for (let guard = 0; guard < 10; guard += 1) {
    const collapsed = page.locator('[data-section] .t3sb-group-row[aria-expanded="false"]')
    if (await collapsed.count() === 0) return
    await collapsed.first().click()
  }
}

/** Start a session in the first workspace, send a prompt, return its id. */
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

const rowIn = (page, sessionId) => page.locator(`[data-section] [data-session-id="${sessionId}"]`)

async function menuAction(page, sessionId, path) {
  await rowIn(page, sessionId).click({ button: 'right' })
  for (const [index, label] of path.entries()) {
    const item = page.getByRole('menuitem', { name: label, exact: true })
    await item.waitFor({ timeout: 5000 })
    if (index < path.length - 1) { await item.hover(); await item.click().catch(() => {}) } else await item.click()
  }
}

/** Hover a row and click its quick task action; returns false when the row offers none. */
async function quickAction(page, sessionId, action) {
  const row = rowIn(page, sessionId)
  await row.hover()
  const button = row.locator(`button[data-action="${action}"]`)
  if (await button.count() === 0) return false
  await button.click()
  return true
}

try {
  if (phase === 'main') {
    const page = await openPage()
    record('N01.default-grouping-status', await grouping(page) === 'status', await grouping(page))
    record('N02.header-composition', await page.locator('.t3sb-section-header').evaluate(el => [
      el.querySelector('.t3sb-section-label')?.textContent,
      el.querySelectorAll('button').length >= 3,
    ].join('|')) === 'Sessions|true')

    // F08: add a workspace through the header's add button.
    await viewOption(page, 'Workspace')
    if (await page.locator('[data-workspace]:not([data-workspace=""])').count() === 0) {
      await page.getByTestId('t3-add-workspace').click()
      await page.getByLabel('Folder path on the host').fill(workspace)
      await page.getByRole('button', { name: 'Add', exact: true }).click()
    }
    record('F08.add-workspace', await waitFor(() => page.locator('[data-workspace]:not([data-workspace=""])').count(), 10000) !== null)
    await viewOption(page, 'Status')

    const done = await startSession(page, 'quick question')
    const slow = await startSession(page, 'long job #slow')
    const workingWhileRunning = await waitFor(async () => (await sectionOf(page, slow))?.section === 'working', 20000)
    record('A02.working-while-running', workingWhileRunning !== null, JSON.stringify(await sectionOf(page, slow)))
    record('N04.no-settle-while-running', !(await quickAction(page, slow, 'settle')))
    await page.screenshot({ path: join(outDir, '01-working.png') })

    const failed = await startSession(page, 'broken job #fail')
    await expandAll(page)
    const doneState = await waitFor(async () => { const s = await sectionOf(page, done); return s?.section === 'active' ? s : null }, 30000)
    record('A02.completed-returns-active', doneState !== null, JSON.stringify(doneState))
    const failedState = await waitFor(async () => { const s = await sectionOf(page, failed); return s?.status === 'failed' ? s : null }, 60000)
    record('F03.failure-visible', failedState !== null, JSON.stringify(await sectionOf(page, failed)))
    record('N03.empty-sections-hidden', !(await sectionKeys(page)).includes('settled') && !(await sectionKeys(page)).includes('snoozed'), JSON.stringify(await sectionKeys(page)))

    const bash = await startSession(page, 'tool job #bash')
    await expandAll(page)
    const bashState = await waitFor(async () => { const s = await sectionOf(page, bash); return s !== null && s.status !== 'running' ? s : null }, 30000)
    record('F03.tool-turn-observed', bashState !== null, JSON.stringify(bashState))
    await page.screenshot({ path: join(outDir, '02-states.png') })

    // N09: arrow keys move focus between rows (group headers and sessions).
    await page.locator('[data-section] .t3sb-group-row').first().focus()
    const focusedKey = () => page.evaluate(() => document.activeElement?.getAttribute('data-row-key') ?? document.activeElement?.className ?? null)
    const start = await focusedKey()
    await page.keyboard.press('ArrowDown')
    const down = await focusedKey()
    await page.keyboard.press('End')
    const end = await focusedKey()
    await page.keyboard.press('Home')
    const home = await focusedKey()
    record('N09.arrow-key-navigation', start !== down && down?.startsWith('session:') === true && end !== home && home === start, JSON.stringify({ start, down, end, home }))

    // N10: keyboard focus on a workspace header reveals its actions and Tab reaches them.
    await viewOption(page, 'Workspace')
    await page.locator('[data-workspace]:not([data-workspace=""]) .t3sb-group-row').first().focus()
    await page.keyboard.press('Tab')
    const tabbed = await page.evaluate(() => {
      const el = document.activeElement
      return el?.tagName === 'BUTTON' && el.closest('.t3sb-group-row') !== null ? el.getAttribute('aria-label') : null
    })
    record('N10.group-actions-keyboard', tabbed !== null, tabbed ?? 'focus left the header')
    await viewOption(page, 'Status')

    // N05: Archive lives in the row's "…" menu (the native session menu).
    const doneRow = rowIn(page, done)
    await doneRow.hover()
    await doneRow.locator('button[data-action="more"]').click()
    const archiveItem = await waitFor(() => page.getByRole('menuitem', { name: 'Archive session' }).count(), 5000)
    record('N05.archive-in-more-menu', archiveItem !== null)
    await page.screenshot({ path: join(outDir, '03-more-menu.png') })
    await page.keyboard.press('Escape')

    // F04: snooze through the native session menu (plugin contribution).
    await menuAction(page, done, ['Snooze', 'In 1 hour'])
    const snoozed = await waitFor(async () => { await expandAll(page); return (await sectionOf(page, done))?.section === 'snoozed' }, 10000)
    record('F04.snooze', snoozed !== null, JSON.stringify(await sectionOf(page, done)))

    // F05 / N06: settle the failed (idle) session with the row's Settle button.
    if (failedState !== null) {
      const clicked = await quickAction(page, failed, 'settle')
      const settled = await waitFor(async () => { await expandAll(page); return (await sectionOf(page, failed))?.section === 'settled' }, 10000)
      record('N06.settle-button', clicked && settled !== null, JSON.stringify(await sectionOf(page, failed)))
    } else {
      record('N06.settle-button', false, 'failed session never reached failed state')
    }
    await page.mouse.move(900, 600)
    await page.screenshot({ path: join(outDir, '04-parked.png') })

    // A06/A09: a second window converges through the Host follow stream.
    const second = await openPage()
    await expandAll(second)
    const secondState = await waitFor(async () => {
      await expandAll(second)
      const a = await sectionOf(second, done)
      const b = await sectionOf(second, failed)
      return a?.section === 'snoozed' && b?.section === 'settled' ? { a, b } : null
    }, 15000)
    record('A06.second-window-baseline', secondState !== null, JSON.stringify(secondState))
    record('N07.unsettle-button', await quickAction(page, failed, 'unsettle'))
    const reopenedRemotely = await waitFor(async () => (await sectionOf(second, failed))?.section === 'active', 10000)
    record('A06.second-window-delta', reopenedRemotely !== null, JSON.stringify(await sectionOf(second, failed)))
    // Re-settle through the menu so the restart phase has one of each.
    await menuAction(page, failed, ['Settle'])
    await waitFor(async () => { await expandAll(page); return (await sectionOf(page, failed))?.section === 'settled' }, 10000)

    // F01: the grouping is remembered across a reload.
    await viewOption(page, 'In one list')
    await page.reload()
    await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 })
    record('F01.grouping-remembered', await grouping(page) === 'flat', await grouping(page))
    await page.screenshot({ path: join(outDir, '05-flat.png') })
    await viewOption(page, 'Status')

    // N08: settings live on this plugin's page under Plugins.
    await viewOption(page, 'Sidebar settings…')
    const settingsPage = await waitFor(() => page.getByTestId('t3-settings-page').count(), 15000)
    record('N08.settings-under-plugins', settingsPage !== null)
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(outDir, '06-settings.png') })

    // A11 partial: the native browser stays hidden while the plugin renders.
    record('A11.single-winner', await page.locator('[class*="bhn1Oq_root"]').count() === 0)
    await writeFile(join(outDir, 'sessions.json'), JSON.stringify({ done, slow, failed, bash }, null, 2))
  } else {
    const ids = JSON.parse(await (await import('node:fs/promises')).readFile(join(outDir, 'sessions.json'), 'utf8'))
    const page = await openPage()
    const survived = await waitFor(async () => {
      await expandAll(page)
      const a = await sectionOf(page, ids.done)
      const b = await sectionOf(page, ids.failed)
      return a?.section === 'snoozed' && b?.section === 'settled' ? { a, b } : null
    }, 20000)
    record('A04.host-restart-keeps-parking', survived !== null, JSON.stringify(survived ?? { done: await sectionOf(page, ids.done), failed: await sectionOf(page, ids.failed) }))
    await page.screenshot({ path: join(outDir, '07-after-restart.png') })
  }
} catch (error) {
  record('scenario.exception', false, error instanceof Error ? error.stack?.slice(0, 600) : String(error))
} finally {
  await writeFile(join(outDir, `results-${phase}.json`), JSON.stringify({ phase, at: new Date().toISOString(), results, errors: errors.slice(0, 20) }, null, 2))
  await browser.close()
}
