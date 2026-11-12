// @vitest-environment happy-dom
/** The settings page in a DOM: workspace overrides, preview, bulk acknowledgement, slot diagnostics. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { policyFromDraft, SettingsPage } from '../../src/client/components/SettingsPage.tsx'
import type { PolicyPreview } from '../../src/contracts/schema.ts'
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
  it('refuses invalid day counts', () => {
    expect(policyFromDraft({ ...draft, days: '0' }, [])).toBeNull()
    expect(policyFromDraft({ ...draft, overrides: { wa: { mode: 'custom', days: '91' } } }, ['wa'])).toBeNull()
    expect(policyFromDraft({ ...draft, enabled: false, days: 'x' }, [])).toMatchObject({ autoSettleAfterDays: null })
  })
})

describe('SettingsPage', () => {
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
    const runtime = fakeRuntime({
      sessions: [session('s1'), session('s2')], workspaces, backend: { policy },
      overrides: { previewPolicy: vi.fn(async () => preview), command },
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

  it('says which plugin shadows the sidebar', async () => {
    const runtime = fakeRuntime({ backend: { policy } })
    runtime.slotStore.set({ known: true, active: false, winner: 'rival-plugin' })
    const view = render(runtime)
    await wait(0)
    expect(view.querySelector('[data-testid="t3-slot-note"]')?.textContent).toBe('settings.slot.shadowed(name=rival-plugin)')
  })
})
