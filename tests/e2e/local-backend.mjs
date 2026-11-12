// Browser-only preview: with the Host half off, the sidebar must fall back to
// the local backend, say so, and keep a Snooze across a reload.
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
const [url, shot] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await page.waitForSelector('[data-backend="local"]', { timeout: 30000 })
await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})
const row = page.locator('[data-section="active"] [data-session-id]:has(.t3sb-time)').first()
const id = await row.getAttribute('data-session-id')
await row.click({ button: 'right' })
await page.getByRole('menuitem', { name: 'Snooze', exact: true }).hover()
await page.getByRole('menuitem', { name: 'In 3 hours', exact: true }).click()
await page.waitForTimeout(800)
// Snoozed is collapsed by default; open it so the parked row renders.
const openSnoozed = () => page.locator('[data-section="snoozed"] .t3sb-group-row[aria-expanded="false"]').click({ timeout: 5000 }).catch(() => {})
await openSnoozed()
const before = await page.evaluate(i => document.querySelector(`[data-session-id="${i}"]`)?.closest('[data-section]')?.getAttribute('data-section'), id)
await page.reload()
await page.waitForSelector('[data-backend="local"]', { timeout: 30000 })
await page.waitForSelector('[data-section="snoozed"]', { timeout: 20000 }).catch(() => {})
await openSnoozed()
await page.waitForFunction(i => document.querySelector(`[data-session-id="${i}"]`) !== null, id, { timeout: 20000 }).catch(() => {})
const after = await page.evaluate(i => document.querySelector(`[data-session-id="${i}"]`)?.closest('[data-section]')?.getAttribute('data-section'), id)
// Settings live on this plugin's page under Plugins.
await page.getByTestId('t3-view-options').click()
await page.getByRole('menuitem', { name: 'Sidebar settings…' }).click()
const note = await page.getByTestId('t3-backend-note').innerText()
await page.getByTestId('t3-backend-note').scrollIntoViewIfNeeded()
await page.screenshot({ path: shot })
console.log(JSON.stringify({ backend: 'local', snoozedBeforeReload: before, afterReload: after, note }))
await browser.close()
