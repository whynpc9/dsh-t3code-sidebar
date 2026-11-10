// T06-style checks through the Host API: Snooze expiry by the Host timer, and
// catch-up of a deadline that passed while the Host was stopped.
// Usage: node tests/e2e/expiry.mjs <url> <sessionId> <set|check> [seconds]
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
const [url, sessionId, mode, seconds = '15'] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` })
const page = await browser.newPage()
await page.goto(url)
await page.waitForTimeout(1500)
const origin = new URL(url).origin
const call = async (name, args) => {
  const response = await page.request.post(`${origin}/api/${name}`, { data: { type: 'client-request', rpcId: `x-${Date.now()}`, method: name, payload: { args } } })
  const body = await response.json()
  return body.result
}
const snapshot = (await call('t3Sidebar/getSnapshot', { t3ProtocolVersion: 1 })).value
const task = snapshot.tasks.find(entry => entry.sessionId === sessionId)
if (mode === 'set') {
  const until = snapshot.serverNow + Number(seconds) * 1000
  const result = await call('t3Sidebar/command', { t3CommandInput: {
    protocolVersion: 1, commandId: `expiry-${Date.now()}`, sessionId, expectedRevision: task?.record.revision ?? 0,
    action: { kind: 'snooze', until }, observedPending: [],
  } })
  console.log(JSON.stringify({ set: result.value?.ok, code: result.value?.code, until, disposition: result.value?.task?.record.disposition.kind }))
} else {
  console.log(JSON.stringify({ disposition: task?.record.disposition.kind, lastSnoozeWakeAt: task?.record.lastSnoozeWakeAt, serverNow: snapshot.serverNow }))
  const history = (await call('t3Sidebar/listTransitions', { t3Limit: 5 })).value
  console.log(JSON.stringify(history.map(entry => ({ from: entry.from, to: entry.to, reason: entry.reason, sessionId: entry.sessionId.slice(8, 16) }))))
}
await browser.close()
