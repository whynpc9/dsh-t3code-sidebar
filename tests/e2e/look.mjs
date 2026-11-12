import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
const [url, shot] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 })
await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})
await page.locator('[data-section="active"] [data-session-id]', { hasText: process.argv[4] ?? '' }).first().click()
await page.waitForTimeout(2500)
await page.screenshot({ path: shot })
console.log((await page.locator('main, [class*="conversation"]').first().innerText().catch(() => '')).slice(0, 1500))
await browser.close()
