// @vitest-environment happy-dom
/** The settings page in a DOM: workspace overrides, preview, bulk acknowledgement, slot diagnostics. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { holidayYearsLabel, localPeakHours, policyFromDraft, SettingsPage } from '../../src/client/components/SettingsPage.tsx'
import type { PolicyPreview } from '../../src/contracts/schema.ts'
import { DEEPSEEK_SCHEDULE } from '../../src/domain/offpeak.ts'
import type { TimePolicy } from '../../src/domain/types.ts'
import { fakeRuntime, session, type FakeRuntime } from './runtime-fake.ts'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = container = null
})

const policy: TimePolicy = {
  revision: 3, autoSettleAfterDays: 7, keepUnacknowledgedFailures: false, keepUnacknowledgedResults: false,
  workspaceOverrides: { wb: { mode: 'off' } },
}
const workspaces = [
  { workspaceId: 'wa', path: '/repo/a', title: 'alpha', sessionIds: ['s1'] },
  { workspaceId: 'wb', path: '/repo/b', title: 'beta', sessionIds: ['s2'] },
]
const preview: PolicyPreview = {
  policyRevision: 3, evaluatedAt: Date.now(), sessions: 2, due: 0,
  nextDeadline: { sessionId: 's1', at: Date.now() + 86_400_000 },
  skips: { 'not-due': 1, 'workspace-off': 1, pinned: 2, 'running-unknown': 1 },
  held: [{ sessionId: 's1', turnEndSeq: 4, reason: 'unacknowledged-failure' }], heldTotal: 1,
}

function render(runtime: FakeRuntime): HTMLElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root!.render(<SettingsPage runtime={runtime} />) })
  return container
}
const wait = (ms: number) => act(() => new Promise<void>(resolve => { setTimeout(resolve, ms) }))

describe('policyFromDraft', () => {
  const draft = { enabled: true, days: '7', keepFailures: false, keepResults: true, overrides: { wa: { mode: 'custom' as const, days: '3' }, gone: { mode: 'off' as const, days: '' } } }
  it('builds a policy write with overrides only for listed workspaces', () => {
    expect(policyFromDraft(draft, ['wa'])).toEqual({
      autoSettleAfterDays: 7, keepUnacknowledgedFailures: false, keepUnacknowledgedResults: true, workspaceOverrides: { wa: { mode: 'custom', days: 3 } },
    })
  })
  it('keeps every stored override while the workspace list is not known', () => {
    expect(policyFromDraft(draft, null)?.workspaceOverrides).toEqual({ wa: { mode: 'custom', days: 3 }, gone: { mode: 'off' } })
  })

  it('refuses invalid day counts', () => {
    expect(policyFromDraft({ ...draft, days: '0' }, [])).toBeNull()
    expect(policyFromDraft({ ...draft, overrides: { wa: { mode: 'custom', days: '91' } } }, ['wa'])).toBeNull()
    expect(policyFromDraft({ ...draft, enabled: false, days: 'x' }, [])).toMatchObject({ autoSettleAfterDays: null })
  })
})

describe('off-peak schedule note', () => {
  it('shows the peak blocks in the local time zone (America/New_York in the suite)', () => {
    // 01:00–04:00 and 06:00–10:00 UTC are 20:00–23:00 and 01:00–05:00 in New York (EST, UTC−5).
    const hours = localPeakHours(DEEPSEEK_SCHEDULE, Date.UTC(2026, 10, 16, 12))
    const local = (h: number) => new Date(Date.UTC(2026, 10, 16, h)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    expect(hours).toBe(`${local(1)}–${local(4)}, ${local(6)}–${local(10)}`)
    expect(new Date(Date.UTC(2026, 10, 16, 1)).getHours()).toBe(20)
  })

  it('names the bundled holiday years', () => {
    expect(holidayYearsLabel([2027, 2026])).toBe('2026–2027')
    expect(holidayYearsLabel([2026])).toBe('2026')
    expect(holidayYearsLabel([2026, 2028])).toBe('2026, 2028')
  })
})

describe('SettingsPage', () => {
  it('toggles the optional Working section, off by default', () => {
    const runtime = fakeRuntime({ sessions: [session('s1')], workspaces, backend: { policy } })
    const view = render(runtime)
    const toggle = view.querySelector<HTMLInputElement>('[data-testid="t3-display-settings"] [role="switch"]')!
    expect(toggle.getAttribute('aria-label')).toBe('settings.workingSection')
    expect(toggle.checked).toBe(false)
    act(() => { toggle.click() })
    expect(runtime.prefs.getSnapshot().workingSection).toBe(true)
    expect(toggle.checked).toBe(true)
  })

  it('toggles off-peak snooze, on by default, and explains the schedule', () => {
    const runtime = fakeRuntime({ sessions: [session('s1')], workspaces, backend: { policy } })
    const view = render(runtime)
    const toggle = view.querySelectorAll<HTMLInputElement>('[data-testid="t3-display-settings"] [role="switch"]')[1]!
    expect(toggle.getAttribute('aria-label')).toBe('settings.offPeakSnooze')
    expect(toggle.checked).toBe(true)
    act(() => { toggle.click() })
    expect(runtime.prefs.getSnapshot().offPeakSnooze).toBe(false)
    expect(toggle.checked).toBe(false)
    const schedule = view.querySelector('[data-testid="t3-offpeak-schedule"]')!
    expect(schedule.textContent).toContain('years=2026–2027')
    expect(schedule.textContent).toContain(`settings.offPeakChecked(date=${DEEPSEEK_SCHEDULE.verifiedOn})`)
    expect(schedule.querySelector('a')!.getAttribute('href')).toBe(DEEPSEEK_SCHEDULE.source)
    expect(view.querySelector('[data-testid="t3-offpeak-now"]')!.textContent).toMatch(/^settings\.offPeakNow\./)
  })

  it('shows the current pricing phase on the Host clock', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 16, 2), toFake: ['Date'] })
    try {
      const runtime = fakeRuntime({ sessions: [session('s1')], workspaces, backend: { policy, clockOffset: 0 } })
      expect(render(runtime).querySelector('[data-testid="t3-offpeak-now"]')!.textContent).toMatch(/^settings\.offPeakNow\.peak\(time=/)
      act(() => { runtime.backendStore.set({ ...runtime.backendStore.getSnapshot(), clockOffset: 3 * 3_600_000 }) })
      expect(container!.querySelector('[data-testid="t3-offpeak-now"]')!.textContent).toMatch(/^settings\.offPeakNow\.offPeak\(time=/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('saves a workspace override chosen on the page', async () => {
    const runtime = fakeRuntime({ sessions: [session('s1'), session('s2')], workspaces, backend: { policy } })
    const view = render(runtime)
    const select = view.querySelector<HTMLSelectElement>('[data-workspace-policy="wa"] select')!
    expect(view.querySelector<HTMLSelectElement>('[data-workspace-policy="wb"] select')!.value).toBe('off')
    act(() => { select.value = 'custom'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    const days = view.querySelector<HTMLInputElement>('[data-workspace-policy="wa"] input')!
    expect(days.value).toBe('7')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(days, '2')
      days.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...view.querySelectorAll('button')].find(button => button.textContent === 'settings.save')!
    await act(async () => { save.click() })
    expect(runtime.setPolicy).toHaveBeenCalledWith({
      autoSettleAfterDays: 7, keepUnacknowledgedFailures: false, keepUnacknowledgedResults: false,
      workspaceOverrides: { wa: { mode: 'custom', days: 2 }, wb: { mode: 'off' } },
    })
  })

  it('previews the draft and acknowledges held results in bulk', async () => {
    const command = vi.fn(async () => ({ ok: true as const, task: null as never, dataRevision: 1, replayed: false }))
    const cleared: PolicyPreview = { ...preview, held: [], heldTotal: 0 }
    const runtime = fakeRuntime({
      sessions: [session('s1'), session('s2')], workspaces, backend: { policy },
      overrides: { previewPolicy: vi.fn(async () => (command.mock.calls.length > 0 ? cleared : preview)), command },
    })
    const view = render(runtime)
    await wait(350)
    expect(runtime.previewPolicy).toHaveBeenCalledWith(expect.objectContaining({ autoSettleAfterDays: 7, workspaceOverrides: { wb: { mode: 'off' } } }))
    const text = view.querySelector('[data-testid="t3-policy-preview"]')!.textContent!
    expect(text).toContain('settings.preview.due(n=0)')
    expect(text).toContain('title=Title s1')
    expect(text).toContain('settings.preview.held(n=1)')
    expect(text).toContain('skip.pinned 2 · skip.workspace-off 1 · skip.unknown 1')
    const ackAll = [...view.querySelectorAll('button')].find(button => button.textContent === 'settings.preview.ackAll')!
    await act(async () => { ackAll.click() })
    expect(command).toHaveBeenCalledWith('s1', { kind: 'acknowledge-result', turnEndSeq: 4 })
    expect(view.textContent).toContain('settings.preview.acknowledged')
  })

  it('acknowledges every page of held results, not only the first 200', async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ sessionId: `s${from + i}`, turnEndSeq: 1, reason: 'unacknowledged-result' as const }))
    const pages: PolicyPreview[] = [
      { ...preview, held: page(0, 200), heldTotal: 250 },
      { ...preview, held: page(200, 50), heldTotal: 50 },
      { ...preview, held: [], heldTotal: 0 },
    ]
    let served = 0
    const command = vi.fn(async () => ({ ok: true as const, task: null as never, dataRevision: 1, replayed: false }))
    const runtime = fakeRuntime({
      sessions: [session('s1')], workspaces, backend: { policy },
      overrides: { previewPolicy: vi.fn(async () => pages[Math.min(served++, pages.length - 1)]!), command },
    })
    const view = render(runtime)
    await wait(350)
    served = 1 // the page shown is the first one; the next read serves the second
    const ackAll = [...view.querySelectorAll('button')].find(button => button.textContent === 'settings.preview.ackAll')!
    await act(async () => { ackAll.click() })
    expect(command).toHaveBeenCalledTimes(250)
    expect(view.textContent).toContain('settings.preview.acknowledged')
  })

  it('reports what is still held when acknowledging makes no progress', async () => {
    const command = vi.fn(async () => ({ ok: false as const, code: 'CONFLICT' as const, message: 'x', task: null }))
    const runtime = fakeRuntime({
      sessions: [session('s1')], workspaces, backend: { policy },
      overrides: { previewPolicy: vi.fn(async () => preview), command },
    })
    const view = render(runtime)
    await wait(350)
    const ackAll = [...view.querySelectorAll('button')].find(button => button.textContent === 'settings.preview.ackAll')!
    await act(async () => { ackAll.click() })
    expect(command).toHaveBeenCalledTimes(1)
    expect(view.textContent).toContain('settings.preview.ackFailed(n=1)')
  })

  it('does not drop stored overrides when saving before the workspace list is ready', async () => {
    const runtime = fakeRuntime({ backend: { policy } })
    runtime.workspacesStore.set({ items: [], pinnedSessionIds: [], archivedSessionIds: [], phase: 'pending' })
    const view = render(runtime)
    const save = [...view.querySelectorAll('button')].find(button => button.textContent === 'settings.save')!
    await act(async () => { save.click() })
    expect(runtime.setPolicy).toHaveBeenCalledWith(expect.objectContaining({ workspaceOverrides: { wb: { mode: 'off' } } }))
  })

  it('says which plugin shadows the sidebar', async () => {
    const runtime = fakeRuntime({ backend: { policy } })
    runtime.slotStore.set({ known: true, active: false, winner: 'rival-plugin' })
    const view = render(runtime)
    await wait(0)
    expect(view.querySelector('[data-testid="t3-slot-note"]')?.textContent).toBe('settings.slot.shadowed(name=rival-plugin)')
  })
})
