// Isolated Harness Web access-gate browser regression.
// Usage: node tests/e2e/access-ui.mjs <server-log> <workspace-path>
// Set HARNESS_NODE_MODULES to the official Harness installation's node_modules,
// and optionally CHROME_PATH. Start the mock-llm fixture and Harness with the
// test access-gate fixture enabled and DSH_T3_A10_INTERACTIONS=answer before
// running. The launch URL stays private.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const [logPath, workspacePath] = process.argv.slice(2)
if (!logPath || !workspacePath || !process.env.HARNESS_NODE_MODULES) throw Error('Expected log, workspace path, and HARNESS_NODE_MODULES')
const protocol = path.join(process.env.HARNESS_NODE_MODULES, '@deepseek-ai/dsh-experimental-liveshare-protocol/lib/index.js')
const { viewerCarrierScript } = await import(pathToFileURL(protocol).href)
const url = fs.readFileSync(logPath, 'utf8').match(/dsh web:\s*(\S+)/)?.[1]
if (!url) throw Error('Launch URL missing from log')
const origin = new URL(url).origin
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
const context = await browser.newContext()
let shuttingDown = false
let stage = 'setup'
try {
  const owner = await context.newPage()
  await owner.goto(url, { waitUntil: 'domcontentloaded' })
  const rpc = async (method, args) => {
    const response = await context.request.post(`${origin}/api/${method}`, { data: {
      type: 'client-request', rpcId: `access-ui-${crypto.randomUUID()}`, method, payload: { args },
    } })
    const result = (await response.json()).result
    assert.equal(result.ok, true, `${method} failed`)
    return result.value
  }
  const workspace = await rpc('workspace/create', { request: { path: workspacePath } })
  const visibleWorkspace = workspace.workspace.workspaceId
  const { sessionId } = await rpc('session/create', { request: { workspaceId: visibleWorkspace } })
  await rpc('session/rename', { request: { sessionId, title: 'A10 visible' } })
  await rpc('session/prompt', { request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Synthetic A10 test' }] } })
  await owner.waitForTimeout(5000)
  const snapshot = await rpc('t3Sidebar/getSnapshot', { t3ProtocolVersion: 1 })
  const task = snapshot.tasks.find(item => item.sessionId === sessionId)
  const settled = await rpc('t3Sidebar/command', { t3CommandInput: {
    protocolVersion: 1, commandId: crypto.randomUUID(), sessionId, expectedRevision: task?.record.revision ?? 0,
    action: { kind: 'settle' }, observedPending: [],
  } })
  assert.equal(settled.ok, true, 'Could not seed settled task')
  const fixture = data => context.request.post(`${origin}/api/t3-a10-fixture`, { data })
  const configure = taskGrant => fixture({ op: 'configure', visibleSession: sessionId, visibleWorkspace, taskGrant })
  await configure(false)
  const page = await context.newPage()
  const taskCalls = []
  await page.addInitScript({ content: viewerCarrierScript({ basePath: '', shareId: 'sidebar-a10', sessionId, readTimeoutMs: 15000 }) })
  await page.addInitScript(() => Object.defineProperty(window, '__DSH_REMOTE_ACCESS__', {
    configurable: true, get: () => ({ type: 'baseline', owner: false, grants: [] }), set: () => {},
  }))
  await page.route('**/__share/rpc?**', async route => {
    try {
      const body = route.request().postDataJSON()
      const response = await fixture(body)
      if ((body.path || body.endpoint || '').includes('t3Sidebar')) taskCalls.push(body.path || body.endpoint)
      await route.fulfill({ status: response.status(), body: await response.text(), headers: { 'content-type': 'application/json' } })
    } catch (error) {
      if (!shuttingDown) throw new Error(`Fixture relay failed: ${error.name}`)
    }
  })
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
  stage = 'denied viewer'
  await page.getByText('Workspaces', { exact: true }).waitFor()
  await page.waitForTimeout(1500)
  assert.equal(await page.locator('[class*="t3sb"]').count(), 0)
  assert.equal(taskCalls.length, 0)
  await configure(true)
  stage = 'granted viewer'
  await page.getByText('Settled', { exact: true }).click({ timeout: 10000 })
  const row = page.getByText('A10 visible', { exact: true })
  await row.waitFor()
  await row.click({ button: 'right' })
  await page.getByText('Unsettle', { exact: true }).waitFor()
  await configure(false)
  stage = 'revoked viewer'
  await page.getByText('Workspaces', { exact: true }).waitFor({ timeout: 10000 })
  await page.getByText('Unsettle', { exact: true }).waitFor({ state: 'detached', timeout: 10000 })
  assert.equal(await page.locator('[class*="t3sb"]').count(), 0)
  assert.equal(await page.getByText('A10 visible', { exact: true }).count(), 0)
  assert.equal(await page.getByText('Unsettle', { exact: true }).count(), 0)
  assert.equal(taskCalls.filter(call => call.endsWith('/command')).length, 0)
  const after = await rpc('t3Sidebar/getSnapshot', { t3ProtocolVersion: 1 })
  assert.equal(after.tasks.find(item => item.sessionId === sessionId)?.record.disposition.kind, 'settled')
  console.log('PASS: denied, granted with settled menu, and revoked viewer states')
} catch (error) {
  // Playwright errors can include the one-use launch URL or request cookies.
  console.error(`FAIL: access UI regression at ${stage} (${error.name})`)
  process.exitCode = 1
} finally {
  shuttingDown = true
  await context.close()
  await browser.close()
}
