// "Resume at off-peak" against a real Harness Web host whose clock is shifted
// (tests/fixtures/shift-clock.mjs) to shortly before a DeepSeek peak block
// ends, with the scripted mock model (tests/fixtures/mock-llm.mjs).
// Usage: node tests/e2e/offpeak-resume.mjs <host-log> <state.json> <main|arm|late>
//   main  checks 1–5: capability, the dialog flow in the real UI, delivery at
//         the boundary, "Return now" cancelling, human input cancelling.
//   arm   resume-snoozes a fresh session (then stop the Host before the boundary).
//   late  after restarting the Host (same clock shift) past the boundary:
//         reports whether, and when, the overdue message was delivered.
// Pass the Host log so its one-time launch URL stays out of command output.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { hostUrl, launchChromium, rpc } from './harness-web.mjs'

const [log, statePath, mode] = process.argv.slice(2)
assert(log && statePath && ['main', 'arm', 'late'].includes(mode), 'usage: offpeak-resume.mjs <host-log> <state.json> <main|arm|late>')

const browser = await launchChromium()
const results = []
function record(id, pass, detail) {
  results.push({ id, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${detail ?? ''}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, timeoutMs = 30000, stepMs = 500) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) return null
    await sleep(stepMs)
  }
}

const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.goto(await hostUrl(log))
await page.waitForSelector('[data-t3-sidebar]', { timeout: 30000 })
await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})

const snapshot = () => rpc(page, 't3Sidebar/getSnapshot', { t3ProtocolVersion: 1 })
const taskOf = async sessionId => (await snapshot()).tasks.find(task => task.sessionId === sessionId)
const iso = at => new Date(at).toISOString()
const scheduleView = id => rpc(page, 'schedule/view', { request: { id } })
const prompt = (sessionId, text) => rpc(page, 'session/prompt', {
  request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] },
})
async function events(sessionId) {
  const read = await rpc(page, 'session/events', { request: { address: { kind: 'session', sessionId }, maxMessages: 200 } })
  return (read.records ?? []).filter(entry => entry.type === 'event').map(entry => entry.event).map(event => ({
    seq: event.seq, time: event.time, type: event.type, source: event.data?.source?.kind, reason: event.data?.reason?.kind,
    text: event.type === 'user/message' ? (event.data?.content ?? []).map(part => part.text ?? '').join(' ') : undefined,
  })).filter(event => event.type === 'user/message' || event.type.startsWith('turn/'))
}
const brief = list => list.map(event => `${event.seq}:${event.type}${event.source ? `:${event.source}` : ''}${event.reason ? `:${event.reason}` : ''}`
  + `${event.text?.startsWith('[SCHEDULE') ? `:${event.text.slice(1, event.text.indexOf(']'))}` : ''}@${iso(event.time).slice(11, 19)}`).join(' ')
const reminders = list => list.filter(event => event.type === 'user/message' && event.source === 'schedule' && event.text.includes('[SCHEDULE REMINDER]'))

/** A new session that ran one short turn and is idle again (as the plugin sees it). */
async function idleSession(text) {
  const { sessionId } = await rpc(page, 'session/create', { request: {} })
  await prompt(sessionId, text)
  await rpc(page, 'session/wait', { request: { sessionId, timeoutMs: 20000 } }).catch(() => undefined)
  const idle = await waitFor(async () => {
    const task = await taskOf(sessionId)
    return task !== undefined && task.record.activity.lastTurnEnd !== null && Array.isArray(task.activity) && task.activity.length === 0
  }, 20000)
  assert(idle, `session ${sessionId} did not become idle`)
  return sessionId
}

async function resume(sessionId, until, text) {
  const task = await taskOf(sessionId)
  return await rpc(page, 't3Sidebar/command', {
    t3CommandInput: {
      protocolVersion: 1, commandId: randomUUID(), sessionId, expectedRevision: task?.record.revision ?? 0,
      action: { kind: 'snooze', until, origin: 'off-peak', resume: { prompt: text } }, observedPending: [],
    },
  })
}

/** End of the current DeepSeek peak block on the Host clock (01:00–04:00, 06:00–10:00 UTC). */
function peakEnd(now) {
  const day = Math.floor(now / 86_400_000) * 86_400_000
  const hour = (now - day) / 3_600_000
  if (hour >= 1 && hour < 4) return day + 4 * 3_600_000
  if (hour >= 6 && hour < 10) return day + 10 * 3_600_000
  return null
}

const rowIn = sessionId => page.locator(`[data-section] [data-session-id="${sessionId}"]`)
async function expandAll() {
  for (let guard = 0; guard < 10; guard += 1) {
    const collapsed = page.locator('[data-section] .t3sb-group-row[aria-expanded="false"]')
    if (await collapsed.count() === 0) return
    await collapsed.first().click()
  }
}
async function menuAction(sessionId, path) {
  await expandAll()
  await rowIn(sessionId).click({ button: 'right' })
  for (const [index, label] of path.entries()) {
    const item = page.getByRole('menuitem', { name: label, exact: true })
    await item.waitFor({ timeout: 5000 })
    if (index < path.length - 1) { await item.hover(); await item.click().catch(() => {}) } else await item.click()
  }
}

try {
  if (mode === 'main') {
    // ── 1: capability, and the Host clock really is shifted into a peak block ──
    const first = await snapshot()
    const boundary = peakEnd(first.serverNow)
    record('R1.capability', first.capabilities.hostSchedule === true && boundary !== null,
      `hostSchedule=${first.capabilities.hostSchedule} serverNow=${iso(first.serverNow)} boundary=${boundary && iso(boundary)} skew=${Math.round((first.serverNow - Date.now()) / 1000)}s`)
    assert(boundary !== null, 'the Host clock is not inside a peak block')

    const [a, b, c] = [await idleSession('resume A'), await idleSession('resume B'), await idleSession('resume C')]

    // ── 2: the dialog in the real UI creates the schedule; the row shows it ──
    await menuAction(a, ['Snooze', 'Resume at off-peak…'])
    const message = page.locator('textarea')
    await message.waitFor({ timeout: 5000 })
    const defaultText = await message.inputValue()
    const dialogText = await page.locator('.t3sb-dialog-body').innerText()
    await message.fill('Continue. #resume-A')
    await page.getByRole('button', { name: 'Schedule', exact: true }).click()
    const parkedA = await waitFor(async () => (await taskOf(a))?.record.disposition.resume?.scheduleId)
    const viewA = parkedA ? await scheduleView(parkedA) : null
    // Status grouping shows the task line in the row's hover card.
    await expandAll()
    await rowIn(a).hover()
    const line = await page.locator('.t3sb-hover-task').first().innerText({ timeout: 5000 }).catch(() => null)
    await page.mouse.move(900, 600)
    const listed = (await rpc(page, 'schedule/list', { request: { active: true } })).items.some(item => item.id === parkedA)
    record('R2.dialog-creates-schedule',
      defaultText === 'Continue.' && viewA?.target?.sessionId === a && viewA?.scheduledAt === iso(boundary) && viewA?.status === 'active'
        && viewA?.prompt === 'Continue. #resume-A' && listed && /^Resumes at /.test(line ?? ''),
      `default=${JSON.stringify(defaultText)} dialog=${JSON.stringify(dialogText.replace(/\s+/g, ' ').slice(0, 80))} schedule=${JSON.stringify({ id: viewA?.id, kind: viewA?.kind, title: viewA?.title, scheduledAt: viewA?.scheduledAt, target: viewA?.target, status: viewA?.status })} listed=${listed} row=${JSON.stringify(line)}`)

    // ── 4 (setup): B resume-snoozed, then "Return now" in the UI before the boundary ──
    const armedB = await resume(b, boundary, 'Continue. #resume-B')
    const scheduleB = armedB.task?.record.disposition.resume?.scheduleId
    await menuAction(b, ['Return now and cancel resume'])
    const returnedAt = (await snapshot()).serverNow
    const backB = await waitFor(async () => (await taskOf(b))?.record.disposition.kind === 'normal', 10000)
    const goneB = await waitFor(async () => (await scheduleView(scheduleB)).code === 'schedule_not_found', 15000)

    // ── 5 (setup): C resume-snoozed, then a human message before the boundary ──
    const armedC = await resume(c, boundary, 'Continue. #resume-C')
    const scheduleC = armedC.task?.record.disposition.resume?.scheduleId
    await prompt(c, 'human takes over')
    const wokeC = await waitFor(async () => (await taskOf(c))?.record.disposition.kind === 'normal', 15000)
    const goneC = await waitFor(async () => (await scheduleView(scheduleC)).code === 'schedule_not_found', 15000)
    const transitionsC = (await rpc(page, 't3Sidebar/listTransitions', { t3Limit: 50 })).filter(entry => entry.sessionId === c)

    const before = (await snapshot()).serverNow
    record('R0.armed-before-boundary', before < boundary && armedB.ok === true && armedC.ok === true,
      `hostNow=${iso(before)} (${Math.round((boundary - before) / 1000)}s before the boundary)`)

    // ── wait past the boundary ──
    await waitFor(async () => (await snapshot()).serverNow > boundary + 45_000, 10 * 60_000, 2000)

    // ── 3: delivered at the boundary, a turn ran, the session left Snoozed ──
    const eventsA = await events(a)
    const reminderA = reminders(eventsA)[0]
    const turnAfter = reminderA !== undefined && eventsA.some(event => event.type === 'turn/end' && event.seq > reminderA.seq)
    const taskA = await taskOf(a)
    const endedA = parkedA ? await scheduleView(parkedA) : null
    // The expiry is materialized by whichever comes first: the deadline sweep or the fold of the delivered turn.
    const expiredA = (await rpc(page, 't3Sidebar/listTransitions', { t3Limit: 50 })).find(entry => entry.sessionId === a && entry.from === 'snoozed')
    record('R3.delivered-at-boundary',
      reminderA !== undefined && reminderA.time >= boundary && reminderA.time - boundary < 15_000 && reminderA.text.includes('#resume-A')
        && turnAfter && taskA?.record.disposition.kind === 'normal' && taskA?.record.lastSnoozeWakeAt === boundary && endedA?.status === 'ended',
      `reminder@${reminderA && iso(reminderA.time)} (+${reminderA ? reminderA.time - boundary : '?'}ms) schedule=${endedA?.status} transition=${expiredA?.reason}@${expiredA && iso(expiredA.at)} wake=${taskA && iso(taskA.record.lastSnoozeWakeAt)} events=${brief(eventsA)}`)

    // ── 4: nothing delivered to B, and the deletion notice started no turn ──
    const eventsB = await events(b)
    const turnsAfterReturn = eventsB.filter(event => event.type === 'turn/start' && event.time >= returnedAt)
    record('R4.return-now-cancels', backB !== null && goneB !== null && reminders(eventsB).length === 0 && turnsAfterReturn.length === 0,
      `normal=${backB !== null} schedule=${goneB !== null ? 'deleted' : 'still there'} events=${brief(eventsB)}`)

    // ── 5: a human message woke C and removed its schedule; only the human turn ran ──
    const eventsC = await events(c)
    record('R5.human-input-cancels', wokeC !== null && goneC !== null && reminders(eventsC).length === 0,
      `normal=${wokeC !== null} schedule=${goneC !== null ? 'deleted' : 'still there'} transitions=${JSON.stringify(transitionsC.map(entry => entry.reason))} events=${brief(eventsC)}`)
  } else if (mode === 'arm') {
    const first = await snapshot()
    const boundary = peakEnd(first.serverNow)
    assert(boundary !== null, 'the Host clock is not inside a peak block')
    const d = await idleSession('resume D')
    const armed = await resume(d, boundary, 'Continue. #resume-D')
    const scheduleId = armed.task?.record.disposition.resume?.scheduleId
    await writeFile(statePath, JSON.stringify({ sessionId: d, scheduleId, boundary }))
    record('R6.armed', armed.ok === true && scheduleId !== undefined,
      `hostNow=${iso((await snapshot()).serverNow)} boundary=${iso(boundary)} schedule=${scheduleId}`)
  } else {
    const { sessionId, scheduleId, boundary } = JSON.parse(await readFile(statePath, 'utf8'))
    const startedAt = (await snapshot()).serverNow
    const delivered = await waitFor(async () => reminders(await events(sessionId))[0], 90_000, 2000)
    const view = await scheduleView(scheduleId)
    const list = await events(sessionId)
    const task = await taskOf(sessionId)
    const at = delivered?.time
    record('R6.late-delivery', true,
      `restartedAt=${iso(startedAt)} boundary=${iso(boundary)} delivered=${at ? `${iso(at)} (+${Math.round((at - boundary) / 1000)}s after the boundary)` : 'no'} `
      + `schedule=${view.status ?? view.code} lastDelivery=${view.lastDelivery?.deliveredAt} task=${task?.record.disposition.kind} events=${brief(list)}`)
  }
} finally {
  if (errors.length > 0) console.log(`page errors: ${errors.slice(0, 5).join(' | ')}`)
  await browser.close()
}
console.log(`${results.filter(result => result.pass).length}/${results.length} passed`)
if (results.some(result => !result.pass)) process.exitCode = 1
