// @vitest-environment happy-dom
/**
 * "Resume at off-peak": the dialog (targets, message, disabled states, the
 * exact action, refusals) and the Sidebar rendering it from its request store.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandOutcome } from '../../src/client/backend.ts'
import { ResumeDialog } from '../../src/client/components/Dialogs.tsx'
import { TaskSidebar } from '../../src/client/components/Sidebar.tsx'
import { fakeRuntime, session, type FakeRuntime } from './runtime-fake.ts'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
  vi.useRealTimers()
})

const monday = (hour: number) => Date.UTC(2026, 10, 16, hour)
const refused = (code: string): CommandOutcome => ({ ok: false, code: code as never, message: 'refused', task: null })

function render(runtime: FakeRuntime, onClose = vi.fn()): HTMLElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root!.render(<ResumeDialog runtime={runtime} sessionId="s1" onClose={onClose} />) })
  return container
}

const button = (view: HTMLElement, text: string) => [...view.querySelectorAll('button')].find(entry => entry.textContent === text)!
const textarea = (view: HTMLElement) => view.querySelector('textarea')!

function type(element: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ResumeDialog', () => {
  it('offers both off-peak targets, pre-fills the message and submits the exact action', async () => {
    vi.useFakeTimers({ now: monday(2), toFake: ['Date'] })
    const onClose = vi.fn()
    const runtime = fakeRuntime({ backend: { clockOffset: 0 } })
    const command = vi.mocked(runtime.command).mockResolvedValue({ ok: true } as CommandOutcome)
    const view = render(runtime, onClose)
    const radios = [...view.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    expect(radios.map(radio => [radio.value, radio.checked])).toEqual([['next', true], ['long', false]])
    expect(view.textContent).toContain('resume.next(time=')
    expect(view.textContent).toContain('resume.long(time=')
    expect(textarea(view).value).toBe('resume.defaultMessage')
    act(() => { radios[1]!.click() })
    type(textarea(view), '  Keep going with the tests.\n')
    await act(async () => { button(view, 'resume.confirm').click() })
    expect(command).toHaveBeenCalledWith('s1', {
      kind: 'snooze', until: monday(10), origin: 'off-peak', resume: { prompt: 'Keep going with the tests.' },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a single target as text, on the Host clock', () => {
    // Local clock 12:00 UTC (off-peak), Host clock 07:00 UTC (late peak block).
    vi.useFakeTimers({ now: monday(12), toFake: ['Date'] })
    const runtime = fakeRuntime({ backend: { clockOffset: -5 * 3_600_000 } })
    const view = render(runtime)
    expect(view.querySelectorAll('input[type="radio"]')).toHaveLength(0)
    expect(view.querySelector('[data-testid="t3-resume-at"]')!.textContent).toMatch(/^resume\.at\(time=/)
  })

  it('disables Confirm for an empty message and while the backend is not ready', () => {
    vi.useFakeTimers({ now: monday(2), toFake: ['Date'] })
    const runtime = fakeRuntime({ backend: { clockOffset: 0 } })
    const view = render(runtime)
    expect(button(view, 'resume.confirm').disabled).toBe(false)
    type(textarea(view), '   \n ')
    expect(button(view, 'resume.confirm').disabled).toBe(true)
    type(textarea(view), 'Continue.')
    act(() => { runtime.backendStore.set({ ...runtime.backendStore.getSnapshot(), status: 'stale' }) })
    expect(button(view, 'resume.confirm').disabled).toBe(true)
  })

  it('shows a refusal inside the dialog and stays open', async () => {
    vi.useFakeTimers({ now: monday(2), toFake: ['Date'] })
    const onClose = vi.fn()
    const runtime = fakeRuntime({ backend: { clockOffset: 0 } })
    vi.mocked(runtime.command).mockResolvedValue(refused('INVALID_TIME'))
    const view = render(runtime, onClose)
    await act(async () => { button(view, 'resume.confirm').click() })
    expect(view.querySelector('[role="alert"]')!.textContent).toBe('error.generic(code=INVALID_TIME)') // the echo locale has no copy, so errorText falls back
    expect(onClose).not.toHaveBeenCalled()
    expect(button(view, 'resume.confirm').disabled).toBe(false)
  })

  it('sends the shown target after the peak block ended and lets the Host refuse it', async () => {
    vi.useFakeTimers({ now: monday(3), toFake: ['Date'] })
    const runtime = fakeRuntime({ backend: { clockOffset: 0 } })
    const command = vi.mocked(runtime.command).mockResolvedValue(refused('INVALID_TIME'))
    const view = render(runtime)
    vi.setSystemTime(monday(5)) // off-peak now: nothing to recompute, the shown target goes to the Host
    await act(async () => { button(view, 'resume.confirm').click() })
    expect(command).toHaveBeenCalledWith('s1', expect.objectContaining({ until: monday(4), origin: 'off-peak' }))
    expect(view.querySelector('[role="alert"]')!.textContent).toBe('error.generic(code=INVALID_TIME)') // the echo locale has no copy, so errorText falls back
  })

  it('submits the time on screen even when a later peak block offers another boundary', async () => {
    vi.useFakeTimers({ now: monday(3), toFake: ['Date'] })
    const runtime = fakeRuntime({ backend: { clockOffset: 0 } })
    const command = vi.mocked(runtime.command).mockResolvedValue(refused('INVALID_TIME'))
    const view = render(runtime)
    vi.setSystemTime(monday(7)) // next peak block: its "next" boundary would be 10:00, not the 04:00 shown
    await act(async () => { button(view, 'resume.confirm').click() })
    expect(command).toHaveBeenCalledWith('s1', expect.objectContaining({ until: monday(4) }))
    expect(view.querySelector('[role="alert"]')).not.toBeNull()
  })
})

describe('Sidebar resume request', () => {
  it('opens the dialog from its request store and clears it on cancel', () => {
    vi.useFakeTimers({ now: monday(2), toFake: ['Date'] })
    const runtime = fakeRuntime({ sessions: [session('s1')], backend: { clockOffset: 0 } })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => { root!.render(<TaskSidebar runtime={runtime} />) })
    expect(container.querySelector('textarea')).toBeNull()
    act(() => { runtime.resumeRequest.set('s1') })
    expect(container.querySelector('textarea')!.value).toBe('resume.defaultMessage')
    act(() => { button(container!, 'resume.cancel').click() })
    expect(runtime.resumeRequest.getSnapshot()).toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
    expect(runtime.command).not.toHaveBeenCalled()
  })
})
