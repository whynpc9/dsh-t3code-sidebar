/**
 * Dialogs raised from the sidebar and its menus, on the native Modal: custom
 * Snooze time, "Resume at off-peak", and adding, renaming and removing a workspace.
 */
import { useState, useSyncExternalStore } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { DEEPSEEK_SCHEDULE, offPeakSnoozeTargets, type OffPeakTarget } from '../../domain/offpeak.ts'
import { parseLocalDateTime, snoozePresets, validateSnoozeUntil } from '../../domain/time.ts'
import type { Key } from '../locales.ts'
import type { Runtime } from '../runtime.ts'
import { clockLabel } from './Rows.tsx'

const errorText = (t: Runtime['t'], code: string): string => {
  const key = `error.${code}` as Key
  const text = t(key)
  return text === key ? t('error.generic', { code }) : text
}

const reasonText = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

function toLocalInput(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function SnoozeDialog({ runtime, sessionId, now, onClose }: {
  runtime: Runtime
  sessionId: string
  now: number
  onClose: () => void
}) {
  const t = runtime.t
  const backend = useSyncExternalStore(runtime.backend.subscribe, runtime.backend.getSnapshot)
  const ready = backend.status === 'ready'
  const [value, setValue] = useState(() => toLocalInput(snoozePresets(now).find(preset => preset.id === 'tomorrow-09')?.until ?? now + 3_600_000))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    // Reject wall-clock times that do not exist locally (DST gap) rather than shifting them.
    const until = parseLocalDateTime(value)
    if (until === null || validateSnoozeUntil(until, now) !== null) { setError(t('snooze.invalid')); return }
    setBusy(true)
    const result = await runtime.command(sessionId, { kind: 'snooze', until })
    setBusy(false)
    if (result.ok) onClose()
    else setError(errorText(t, result.code))
  }
  return (
    <Modal open onClose={onClose} title={t('snooze.title')} description={t('snooze.note')} closeLabel={t('dialog.close')}
      footer={(
        <div className="t3sb-dialog-footer">
          <Button variant="outline" onClick={onClose}>{t('snooze.cancel')}</Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => { void submit() }}>{t('snooze.confirm')}</Button>
        </div>
      )}>
      <div className="t3sb-dialog-body">
        <Input type="datetime-local" value={value} autoFocus aria-label={t('snooze.title')}
          onChange={(event) => { setValue(event.target.value); setError(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} />
        {error !== null && <p className="t3sb-error" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}

/**
 * "Resume at off-peak": snooze until an off-peak boundary and have the Harness
 * send a message then. Targets come from the Host-corrected clock when the
 * dialog opens and are submitted as shown, never silently swapped for a later
 * boundary; the Host validates everything again (once the shown instant is no
 * longer offered it answers INVALID_TIME, shown here).
 */
export function ResumeDialog({ runtime, sessionId, onClose }: {
  runtime: Runtime
  sessionId: string
  onClose: () => void
}) {
  const t = runtime.t
  const backend = useSyncExternalStore(runtime.backend.subscribe, runtime.backend.getSnapshot)
  const ready = backend.status === 'ready'
  const clockNow = () => Date.now() + runtime.backend.getSnapshot().clockOffset
  const [targets] = useState<OffPeakTarget[]>(() => offPeakSnoozeTargets(DEEPSEEK_SCHEDULE, clockNow()))
  const [choice, setChoice] = useState<OffPeakTarget['kind']>('next')
  const [prompt, setPrompt] = useState(() => t('resume.defaultMessage'))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const shownAt = clockNow()
  const label = (target: OffPeakTarget) =>
    t(target.kind === 'next' ? 'resume.next' : 'resume.long', { time: clockLabel(target.until, shownAt) })
  const submit = async () => {
    if (prompt.trim() === '' || busy) return
    // Send exactly the instant on screen; once it is no longer offered the Host answers INVALID_TIME.
    const chosen = targets.find(target => target.kind === choice)
    if (chosen === undefined) { setError(errorText(t, 'INVALID_TIME')); return }
    setBusy(true)
    const result = await runtime.command(sessionId, { kind: 'snooze', until: chosen.until, origin: 'off-peak', resume: { prompt: prompt.trim() } })
    setBusy(false)
    if (result.ok) onClose()
    else setError(errorText(t, result.code))
  }
  return (
    <Modal open onClose={onClose} title={t('resume.title')} description={t('resume.note')} closeLabel={t('dialog.close')}
      footer={(
        <div className="t3sb-dialog-footer">
          <Button variant="outline" onClick={onClose}>{t('resume.cancel')}</Button>
          <Button variant="primary" disabled={!ready || busy || prompt.trim() === ''} onClick={() => { void submit() }}>{t('resume.confirm')}</Button>
        </div>
      )}>
      <div className="t3sb-dialog-body">
        {targets.length > 1
          ? (
              <div className="t3sb-choices" role="radiogroup" aria-label={t('resume.when')}>
                {targets.map(target => (
                  <label key={target.kind} className="t3sb-choice">
                    <input type="radio" name="t3sb-resume-at" value={target.kind} checked={choice === target.kind}
                      onChange={() => { setChoice(target.kind); setError(null) }} />
                    <span>{label(target)}</span>
                  </label>
                ))}
              </div>
            )
          : targets[0] !== undefined && (
            <p className="t3sb-dialog-note" data-testid="t3-resume-at">{t('resume.at', { time: clockLabel(targets[0].until, shownAt) })}</p>
          )}
        <textarea className="t3sb-field t3sb-textarea" value={prompt} rows={3} autoFocus aria-label={t('resume.message')}
          onChange={(event) => { setPrompt(event.target.value); setError(null) }} />
        {error !== null && <p className="t3sb-error" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}

export function AddWorkspaceDialog({ runtime, onClose }: { runtime: Runtime; onClose: () => void }) {
  const t = runtime.t
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const trimmed = path.trim()
    if (trimmed === '') return
    setBusy(true)
    try {
      await runtime.createWorkspace(trimmed)
      onClose()
    } catch (reason) {
      setError(t('workspace.failed', { reason: reasonText(reason) }))
    } finally {
      setBusy(false)
    }
  }
  const browse = async () => {
    const picked = await runtime.pickDirectory()
    if (picked !== null) { setPath(picked); setError(null) }
  }
  return (
    <Modal open onClose={onClose} title={t('workspace.add')} closeLabel={t('dialog.close')}
      footer={(
        <div className="t3sb-dialog-footer">
          <Button variant="outline" onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" disabled={busy || path.trim() === ''} onClick={() => { void submit() }}>{t('workspace.create')}</Button>
        </div>
      )}>
      <div className="t3sb-dialog-body">
        <div className="t3sb-dialog-row">
          <Input value={path} placeholder={t('workspace.path')} aria-label={t('workspace.path')} autoFocus
            onChange={(event) => { setPath(event.target.value); setError(null) }}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} />
          <Button variant="outline" onClick={() => { void browse() }}>{t('workspace.browse')}</Button>
        </div>
        {error !== null && <p className="t3sb-error" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}

export function RenameWorkspaceDialog({ runtime, workspaceId, title, onClose }: { runtime: Runtime; workspaceId: string; title: string; onClose: () => void }) {
  const t = runtime.t
  const [name, setName] = useState(title)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const unchanged = name.trim() === '' || name.trim() === title
  const submit = async () => {
    if (unchanged) return
    setBusy(true)
    try {
      await runtime.renameWorkspace(workspaceId, name.trim())
      onClose()
    } catch (reason) {
      setError(t('workspace.failed', { reason: reasonText(reason) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('workspace.renameTitle')} closeLabel={t('dialog.close')}
      footer={(
        <div className="t3sb-dialog-footer">
          <Button variant="outline" onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" disabled={busy || unchanged} onClick={() => { void submit() }}>{t('dialog.save')}</Button>
        </div>
      )}>
      <div className="t3sb-dialog-body">
        <Input value={name} aria-label={t('workspace.name')} autoFocus
          onChange={(event) => { setName(event.target.value); setError(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} />
        {error !== null && <p className="t3sb-error" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}

export function RemoveWorkspaceDialog({ runtime, workspaceId, title, onClose }: { runtime: Runtime; workspaceId: string; title: string; onClose: () => void }) {
  const t = runtime.t
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      await runtime.deleteWorkspace(workspaceId)
      onClose()
    } catch (reason) {
      setError(t('workspace.failed', { reason: reasonText(reason) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('workspace.remove')} closeLabel={t('dialog.close')}
      footer={(
        <div className="t3sb-dialog-footer">
          <Button variant="outline" onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>{t('workspace.remove')}</Button>
        </div>
      )}>
      <div className="t3sb-dialog-body">
        <p className="t3sb-dialog-note">{t('workspace.removeConfirm', { name: title })}</p>
        {error !== null && <p className="t3sb-error" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
