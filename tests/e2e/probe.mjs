// Usage: node tests/e2e/probe.mjs <url-with-token> <screenshot.png>
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
const [url, shot] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`))
await page.goto(url)
await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3000)
const info = await page.evaluate(() => {
  const root = document.querySelector('[data-t3-sidebar]')
  return {
    view: root?.getAttribute('data-t3-sidebar') ?? null,
    backend: root?.getAttribute('data-backend') ?? null,
    sections: [...document.querySelectorAll('[data-section]')].map(s => s.getAttribute('data-section') + ':' + s.querySelectorAll('[data-session-id]').length),
    header: document.querySelector('.t3sb-section-header')?.textContent ?? null,
    nativeBrowser: document.querySelectorAll('[class*="bhn1Oq_root"]').length,
  }
})
console.log(JSON.stringify(info))
if (shot) await page.screenshot({ path: shot })
console.log(logs.filter(l => /error|warn|t3|sidebar/i.test(l)).slice(0, 30).join('\n'))
await browser.close()
