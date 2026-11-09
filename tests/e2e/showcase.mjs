// Capture evidence screenshots of the main surfaces.
// Usage: node tests/e2e/showcase.mjs <url> <out-dir>
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
import { join } from 'node:path'
const [url, out] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
async function shoot(locale, colorScheme, suffix) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale, colorScheme })
  const page = await context.newPage()
  await page.goto(url)
  await page.waitForSelector('[data-backend="host"]', { timeout: 30000 })
  await page.locator('button', { hasText: /^(Continue|继续)$/ }).click({ timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(1000)
  for (const header of await page.locator('[data-section="snoozed"] > .t3sb-section-header[aria-expanded="false"], [data-section="settled"] > .t3sb-section-header[aria-expanded="false"]').all()) await header.click().catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, `tasks-${suffix}.png`), clip: { x: 0, y: 0, width: 640, height: 820 } })
  const row = page.locator('[data-section="active"] [data-session-id] .t3sb-row-main').first()
  await row.click({ button: 'right' })
  await page.waitForTimeout(500)
  await page.getByRole('menuitem').nth(1).hover().catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, `menu-${suffix}.png`), clip: { x: 0, y: 0, width: 800, height: 820 } })
  await page.keyboard.press('Escape')
  await page.getByTestId('t3-view-projects').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, `projects-${suffix}.png`), clip: { x: 0, y: 0, width: 640, height: 820 } })
  await page.getByTestId('t3-view-tasks').click()
  await page.getByTestId('t3-settings').click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(out, `settings-${suffix}.png`), clip: { x: 0, y: 0, width: 640, height: 820 } })
  await context.close()
}
await shoot('en-US', 'light', 'en-light')
await shoot('zh-CN', 'dark', 'zh-dark')
await browser.close()
console.log('ok')
