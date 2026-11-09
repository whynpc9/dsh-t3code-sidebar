// Print the Host t3Sidebar snapshot through the authenticated /api route.
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
const [url, method = 'getSnapshot', args = '{"protocolVersion":1}'] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
const page = await browser.newPage()
await page.goto(url)
await page.waitForTimeout(1500)
const origin = new URL(url).origin
const call = (name, payload) => page.request.post(`${origin}/api/${name}`, {
  data: { type: 'client-request', rpcId: `dbg-${Date.now()}`, method: name, payload: { args: payload } },
})
const response = await call(`t3Sidebar/${method}`, JSON.parse(args))
console.log(response.status(), (await response.text()).slice(0, 6000))

await browser.close()
