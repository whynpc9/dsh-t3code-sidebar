// End-to-end checks for approvals, the native ⌘K / ⌘O commands, workspace
// policy overrides with the preview, and result acknowledgement, against a
// real Harness web host with the installed plugin, the scripted mock model
// (tests/fixtures/mock-llm.mjs, MOCK_DELAY_MS≈10000) and the test-only
// approval gate (tests/fixtures/approval-gate) installed in the same profile.
// Usage: node tests/e2e/features.mjs <url-with-token> <out-dir>
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [url, outDir] = process.argv.slice(2)
await mkdir(outDir, { recursive: true })
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
const results = []
const errors = []

function record(id, pass, detail) {
  results.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${detail ?? ''}`)
}

// Linux Web leaves ⌘K / ⌘O unbound; bind them to two of the combinations
// Linux Web admits (Ctrl+Shift+Comma / Ctrl+Shift+Period) the way the
// Keyboard Shortcuts settings would, before the page loads.
const KEYBINDINGS = JSON.stringify({
  schemaVersion: 1,
  profiles: {
    'web:linux': {
      'session.search': { code: 'Comma', modifiers: ['primary', 'shift'] },
      'workspace.add': { code: 'Period', modifiers: ['primary', 'shift'] },
    },
  },
})

async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await context.addInitScript((value) => { try { localStorage.setItem('dsh.keybindings.v1', value) } catch {} }, KEYBINDINGS)
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
  await page.goto(url)
  await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 })
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})
  return page
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

const sectionOf = (page, sessionId) => page.evaluate((id) => {
  const row = document.querySelector(`[data-section] [data-session-id="${CSS.escape(id)}"]`)
  return row === null ? null : { section: row.closest('[data-section]').getAttribute('data-section'), status: row.getAttribute('data-status') }
}, sessionId)

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
  await expandAll(page)
  return id
}

const rowIn = (page, sessionId) => page.locator(`[data-section] [data-session-id="${sessionId}"]`)

/** Open the row's native session menu and return the visible item labels. */
async function menuItems(page, sessionId) {
  await rowIn(page, sessionId).click({ button: 'right' })
  await page.getByRole('menuitem').first().waitFor({ timeout: 5000 })
  return await page.getByRole('menuitem').allTextContents()
}

async function menuAction(page, sessionId, path) {
  await rowIn(page, sessionId).click({ button: 'right' })
  for (const [index, label] of path.entries()) {
    const item = page.getByRole('menuitem', { name: label, exact: true })
    await item.waitFor({ timeout: 5000 })
    if (index < path.length - 1) { await item.hover(); await item.click().catch(() => {}) } else await item.click()
  }
}

async function openSettings(page) {
  await viewOption(page, 'Sidebar settings…')
  await page.getByTestId('t3-settings-page').waitFor({ timeout: 15000 })
}

async function backToSessions(page) {
  await page.goto(url)
  await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 })
  await expandAll(page)
}

try {
  const page = await openPage()
  await expandAll(page)

  // ── A02: a pending approval puts the session in Active with the approval status ──
  const asking = await startSession(page, 'needs approval #askbash')
  const approvalState = await waitFor(async () => { const s = await sectionOf(page, asking); return s?.status === 'approval' ? s : null }, 20000)
  record('A02.approval-visible', approvalState?.section === 'active', JSON.stringify(approvalState ?? await sectionOf(page, asking)))
  await page.screenshot({ path: join(outDir, '11-approval.png') })

  // Snoozing over an unresolved approval is refused; the session stays in Active.
  await menuAction(page, asking, ['Snooze', 'In 1 hour'])
  await page.waitForTimeout(1500)
  record('A05.no-snooze-over-approval', (await sectionOf(page, asking))?.section === 'active', JSON.stringify(await sectionOf(page, asking)))

  // Approving lets the turn finish; the session leaves the approval state.
  await page.getByRole('button', { name: 'Allow once' }).click()
  const approved = await waitFor(async () => { const s = await sectionOf(page, asking); return s !== null && s.status !== 'approval' && s.status !== 'running' ? s : null }, 30000)
  record('A02.approval-resolved', approved !== null, JSON.stringify(approved ?? await sectionOf(page, asking)))

  // ── A03: a new approval wakes a session snoozed while it was running ──
  const late = await startSession(page, 'asks later #delaybash')
  const running = await waitFor(async () => (await sectionOf(page, late))?.section === 'working', 10000)
  await menuAction(page, late, ['Snooze', 'In 1 hour'])
  const snoozed = await waitFor(async () => { await expandAll(page); return (await sectionOf(page, late))?.section === 'snoozed' }, 8000)
  record('A03.snooze-while-running', running !== null && snoozed !== null, JSON.stringify(await sectionOf(page, late)))
  const woken = await waitFor(async () => { await expandAll(page); const s = await sectionOf(page, late); return s?.section === 'active' && s.status === 'approval' ? s : null }, 30000)
  record('A03.new-approval-wakes', woken !== null, JSON.stringify(woken ?? await sectionOf(page, late)))
  // The wake is persisted on the Host (a second window agrees after a fresh baseline).
  const other = await openPage()
  await expandAll(other)
  const persisted = await waitFor(async () => { await expandAll(other); return (await sectionOf(other, late))?.section === 'active' }, 15000)
  record('A03.wake-persisted', persisted !== null, JSON.stringify(await sectionOf(other, late)))
  await other.context().close()
  await page.getByRole('button', { name: 'Allow once' }).click().catch(() => {})
  await page.screenshot({ path: join(outDir, '12-woken.png') })

  // ── ⌘K / ⌘O: the native commands drive this sidebar ──
  const editor = page.getByLabel(/Message or run a task|Describe what you want to build/).first()
  await editor.click()
  await page.keyboard.press('Control+Shift+Comma')
  const searchFocused = await waitFor(() => page.evaluate(() => document.activeElement?.classList.contains('t3sb-search-input') === true), 3000, 100)
  record('U06.shortcut-search-focuses', searchFocused !== null, await page.evaluate(() => document.activeElement?.className ?? null))
  await page.keyboard.press('Escape')
  await editor.click()
  await page.keyboard.press('Control+Shift+Period')
  const addOpen = await waitFor(() => page.getByLabel('Folder path on the host').count(), 3000, 100)
  record('U06.shortcut-add-workspace', addOpen !== null)
  await page.screenshot({ path: join(outDir, '13-shortcut-add.png') })
  await page.keyboard.press('Escape')

  // ── P01: a workspace override saved on the settings page ──
  await openSettings(page)
  const select = page.locator('[data-workspace-policy] select').first()
  await select.selectOption('off')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const saved = await waitFor(() => page.getByText('Saved', { exact: true }).count(), 5000)
  record('P01.workspace-override-saved', saved !== null)
  // A fresh window reads the override back from the Host baseline.
  const fresh = await openPage()
  await openSettings(fresh)
  const persistedMode = await waitFor(async () => { const v = await fresh.locator('[data-workspace-policy] select').first().inputValue(); return v === 'off' ? v : null }, 10000)
  await fresh.context().close()
  record('P01.workspace-override-persisted', persistedMode === 'off', persistedMode ?? 'not off')
  const previewText = await waitFor(async () => {
    const text = await page.getByTestId('t3-policy-preview').textContent()
    return /off for the workspace/.test(text ?? '') ? text : null
  }, 10000)
  record('P04.preview-names-workspace-off', previewText !== null, previewText ?? await page.getByTestId('t3-policy-preview').textContent())
  await page.screenshot({ path: join(outDir, '14-settings-policy.png'), fullPage: true })
  // Back to inherit for the rest of the run.
  await page.locator('[data-workspace-policy] select').first().selectOption('inherit')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await waitFor(() => page.getByText('Saved', { exact: true }).count(), 5000)

  // ── P04: keep unacknowledged failures, then acknowledge one from the menu ──
  await backToSessions(page)
  const failing = await startSession(page, 'broken again #fail')
  await waitFor(async () => (await sectionOf(page, failing))?.status === 'failed', 60000)
  await openSettings(page)
  const keepSwitch = page.getByRole('switch', { name: 'Keep failed sessions until I look at them' })
  if (await keepSwitch.getAttribute('aria-checked') !== 'true') await keepSwitch.click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await waitFor(() => page.getByText('Saved', { exact: true }).count(), 5000)
  const heldPreview = await waitFor(async () => {
    const text = await page.getByTestId('t3-policy-preview').textContent()
    return /Kept until their result is acknowledged/.test(text ?? '') ? text : null
  }, 10000)
  record('P04.preview-held-results', heldPreview !== null, heldPreview ?? await page.getByTestId('t3-policy-preview').textContent())
  await backToSessions(page)
  const before = await menuItems(page, failing)
  record('P04.menu-offers-acknowledge', before.includes('Acknowledge result'), JSON.stringify(before))
  await page.getByRole('menuitem', { name: 'Acknowledge result', exact: true }).click()
  await page.waitForTimeout(1500)
  const after = await menuItems(page, failing)
  await page.keyboard.press('Escape')
  record('P04.acknowledged-result-released', !after.includes('Acknowledge result'), JSON.stringify(after))

  // Restore the default policy so later runs start from it.
  await openSettings(page)
  const keep = page.getByRole('switch', { name: 'Keep failed sessions until I look at them' })
  if (await keep.getAttribute('aria-checked') === 'true') await keep.click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await waitFor(() => page.getByText('Saved', { exact: true }).count(), 5000)
  await writeFile(join(outDir, 'feature-sessions.json'), JSON.stringify({ asking, late, failing }, null, 2))
} catch (error) {
  record('features.exception', false, error instanceof Error ? error.stack?.slice(0, 800) : String(error))
} finally {
  await writeFile(join(outDir, 'results-features.json'), JSON.stringify({ at: new Date().toISOString(), results, errors: errors.slice(0, 20) }, null, 2))
  await browser.close()
}
