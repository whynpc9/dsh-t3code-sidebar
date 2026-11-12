// Capture evidence screenshots of the main surfaces, plus the native sidebar
// for comparison (the bundle is switched off and back on from its Plugins page).
// Usage: node tests/e2e/showcase.mjs <url> <out-dir> [--native]
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
import { join } from 'node:path'
const [url, out, flag] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
const SIDEBAR = { x: 0, y: 0, width: 520, height: 820 }

async function viewOption(page, label) {
  await page.getByTestId('t3-view-options').click()
  await page.getByRole('menuitem', { name: label }).click()
  await page.waitForTimeout(400)
}

async function shoot(locale, colorScheme, suffix) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale, colorScheme })
  const page = await context.newPage()
  await page.goto(url)
  await page.waitForSelector('[data-backend="host"]', { timeout: 30000 })
  await page.locator('button', { hasText: /^(Continue|继续)$/ }).click({ timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(1000)
  const groupBy = locale.startsWith('zh') ? ['按状态', '按工作区', '单列表'] : ['Status', 'Workspace', 'In one list']
  await viewOption(page, groupBy[0])
  await page.mouse.move(900, 700)
  await page.screenshot({ path: join(out, `status-${suffix}.png`), clip: SIDEBAR })
  const row = page.locator('[data-section] .t3sb-session-row:has(button[data-action="settle"])').first()
  await row.hover()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(out, `row-hover-${suffix}.png`), clip: SIDEBAR })
  await row.locator('button[data-action="more"]').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(out, `row-menu-${suffix}.png`), clip: { x: 0, y: 0, width: 640, height: 820 } })
  await page.keyboard.press('Escape')
  await page.getByTestId('t3-view-options').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, `view-options-${suffix}.png`), clip: SIDEBAR })
  await page.keyboard.press('Escape')
  await viewOption(page, groupBy[1])
  await page.mouse.move(900, 700)
  await page.screenshot({ path: join(out, `workspace-${suffix}.png`), clip: SIDEBAR })
  await viewOption(page, groupBy[0])
  await page.getByTestId('t3-search').click()
  await page.keyboard.type('fixture')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(out, `search-${suffix}.png`), clip: SIDEBAR })
  await page.keyboard.press('Escape')
  if (locale === 'en-US') {
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(out, `rail-${suffix}.png`), clip: { x: 0, y: 0, width: 300, height: 400 } })
  }
  await context.close()
}

async function native() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'en-US', colorScheme: 'light' })
  const page = await context.newPage()
  await page.goto(url)
  await page.waitForSelector('[data-backend="host"]', { timeout: 30000 })
  await page.locator('button', { hasText: /^Continue$/ }).click({ timeout: 3000 }).catch(() => {})
  await viewOption(page, 'Sidebar settings…')
  await page.getByTestId('t3-settings-page').waitFor({ timeout: 15000 })
  await page.getByTestId('t3-settings-page').scrollIntoViewIfNeeded()
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(out, 'settings-en-light.png') })
  const toggle = page.locator('[role="switch"]').first()
  await toggle.click()
  await page.waitForFunction(() => document.querySelector('[data-t3-sidebar]') === null, null, { timeout: 30000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(out, 'native-workspace.png'), clip: SIDEBAR })
  await page.locator('[role="switch"]').first().click()
  await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 })
  console.log('native sidebar restored to plugin: ok')
  await context.close()
}

if (flag === '--native') await native()
else {
  await shoot('en-US', 'light', 'en-light')
  await shoot('zh-CN', 'dark', 'zh-dark')
}
await browser.close()
console.log('ok')
