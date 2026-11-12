/**
 * This plugin's configuration, rendered on its own page under Plugins
 * (`plugins.bundle.config`, keyed by the package name): where task state is
 * stored (and why this sidebar is not shown, when another plugin shadows it),
 * the automatic-settle policy with its workspace overrides and a live preview
 * of what it would do, and the recent state changes.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PolicyPreview } from '../../contracts/schema.ts'
import { MAX_AUTO_SETTLE_DAYS, MIN_AUTO_SETTLE_DAYS, type TimePolicy, type WorkspacePolicyOverride } from '../../domain/types.ts'
import type { PolicyDraft } from '../backend.ts'
import type { Key } from '../locales.ts'
import type { Runtime, Transition } from '../runtime.ts'

const PREVIEW_DEBOUNCE_MS = 300
/** Skip reasons listed in the preview summary, in display order (others are folded into "state unknown"). */
const SKIP_ORDER = [
  'pinned', 'parked', 'session-disabled', 'workspace-off', 'reopen-hold', 'running', 'active-work', 'pending', 'unknown',
] as const
const UNKNOWN_SKIPS = new Set(['running-unknown', 'activity-unknown', 'pending-unknown', 'result-unknown', 'scope-unknown', 'unknown'])
/** Upper bound on preview pages "Acknowledge all" walks through (200 held results each). */
const ACK_MAX_ROUNDS = 50

function reasonKey(reason: string): Key {
  if (reason === 'snooze-expired' || reason === 'idle-timeout') return `reason.${reason}`
  if (reason.startsWith('manual:')) return 'reason.manual'
  return 'reason.activity'
}

type OverrideMode = 'inherit' | 'custom' | 'off'
interface OverrideDraft { readonly mode: OverrideMode; readonly days: string }
interface Draft {
  readonly enabled: boolean
  readonly days: string
  readonly keepFailures: boolean
  readonly keepResults: boolean
  readonly overrides: Readonly<Record<string, OverrideDraft>>
}

const validDays = (value: string): boolean => {
  const n = Number(value)
  return value.trim() !== '' && Number.isInteger(n) && n >= MIN_AUTO_SETTLE_DAYS && n <= MAX_AUTO_SETTLE_DAYS
}

function draftOf(policy: TimePolicy): Draft {
  const overrides: Record<string, OverrideDraft> = {}
  for (const [workspaceId, override] of Object.entries(policy.workspaceOverrides)) {
    overrides[workspaceId] = override.mode === 'off' ? { mode: 'off', days: '' } : { mode: 'custom', days: String(override.days) }
  }
  return {
    enabled: policy.autoSettleAfterDays !== null,
    days: String(policy.autoSettleAfterDays ?? 7),
    keepFailures: policy.keepUnacknowledgedFailures,
    keepResults: policy.keepUnacknowledgedResults,
    overrides,
  }
}

/** The draft as a policy write, or null while a day count is invalid. Only listed workspaces keep overrides. */
export function policyFromDraft(draft: Draft, workspaceIds: readonly string[]): PolicyDraft | null {
  if (draft.enabled && !validDays(draft.days)) return null
  const workspaceOverrides: Record<string, WorkspacePolicyOverride> = {}
  for (const workspaceId of workspaceIds) {
    const override = draft.overrides[workspaceId]
    if (override === undefined || override.mode === 'inherit') continue
    if (override.mode === 'off') { workspaceOverrides[workspaceId] = { mode: 'off' }; continue }
    if (!validDays(override.days)) return null
    workspaceOverrides[workspaceId] = { mode: 'custom', days: Number(override.days) }
  }
  return {
    autoSettleAfterDays: draft.enabled ? Number(draft.days) : null,
    keepUnacknowledgedFailures: draft.keepFailures,
    keepUnacknowledgedResults: draft.keepResults,
    workspaceOverrides,
  }
}

export interface SettingsPageProps {
  readonly runtime: Runtime
  /** The Plugins page renders `page` on the bundle's detail page. */
  readonly view?: 'page' | 'summary'
}

export function SettingsPage({ runtime, view = 'page' }: SettingsPageProps) {
  useSyncExternalStore(runtime.locale.subscribe, runtime.locale.getSnapshot)
  const t = runtime.t
  const backend = useSyncExternalStore(runtime.backend.subscribe, runtime.backend.getSnapshot)
  const workspaces = useSyncExternalStore(runtime.workspaces.subscribe, runtime.workspaces.getSnapshot)
  const slot = useSyncExternalStore(runtime.slotStatus.subscribe, runtime.slotStatus.getSnapshot)
  const host = backend.kind === 'host'
  const [draft, setDraft] = useState<Draft>(() => draftOf(backend.policy))
  const [message, setMessage] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly Transition[]>([])
  const [preview, setPreview] = useState<PolicyPreview | null>(null)
  const [previewTick, setPreviewTick] = useState(0)
  const [acknowledging, setAcknowledging] = useState(false)

  // Follow policy changes made elsewhere (another window, a reconnect) while this page is open.
  // Only on a change: re-applying on mount would discard an edit made before the effect ran.
  const policyKey = JSON.stringify(backend.policy)
  const appliedPolicy = useRef(policyKey)
  useEffect(() => {
    if (appliedPolicy.current === policyKey) return
    appliedPolicy.current = policyKey
    setDraft(draftOf(backend.policy))
  }, [policyKey])

  useEffect(() => {
    if (!host || view !== 'page') return
    let live = true
    void runtime.listTransitions(20).then((entries) => { if (live) setHistory(entries) })
    return () => { live = false }
  }, [host, view, runtime, backend.policy.revision])

  const workspaceIds = useMemo(() => workspaces.items.map(item => item.workspaceId), [workspaces.items])
  const pending = policyFromDraft(draft, workspaceIds)
  const pendingKey = pending === null ? null : JSON.stringify(pending)

  // Live preview of the draft (debounced); a late answer for an older draft is dropped.
  useEffect(() => {
    if (!host || view !== 'page' || backend.status !== 'ready' || pendingKey === null) return
    let live = true
    const timer = setTimeout(() => {
      void runtime.previewPolicy(JSON.parse(pendingKey) as PolicyDraft).then((answer) => { if (live) setPreview(answer) })
    }, PREVIEW_DEBOUNCE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [host, view, backend.status, pendingKey, runtime, previewTick, backend.tasks])

  const storage = host ? t('settings.backend.host')
    : backend.kind === 'local' ? t('settings.backend.local') : t('settings.backend.connecting')
  if (view === 'summary') return <>{storage}</>

  const update = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setMessage(null) }
  const updateOverride = (workspaceId: string, patch: Partial<OverrideDraft>) => {
    setDraft(current => ({
      ...current,
      overrides: { ...current.overrides, [workspaceId]: { ...(current.overrides[workspaceId] ?? { mode: 'inherit', days: current.days }), ...patch } },
    }))
    setMessage(null)
  }
  const save = async () => {
    if (pending === null) return
    const result = await runtime.setPolicy(pending)
    if (result.ok) { setMessage(t('settings.saved')); return }
    const key = `error.${result.code}` as Key
    setMessage(t(key) === key ? t('error.generic', { code: result.code }) : t(key))
  }
  // The preview lists at most 200 held results per answer: acknowledge page by
  // page, re-reading the preview, until none is held or a page makes no progress.
  const acknowledgeAll = async () => {
    if (preview === null || pendingKey === null) return
    setAcknowledging(true)
    const draftNow = JSON.parse(pendingKey) as PolicyDraft
    let current: PolicyPreview | null = preview
    for (let round = 0; current !== null && current.held.length > 0 && round < ACK_MAX_ROUNDS; round += 1) {
      let progressed = false
      for (const item of current.held) {
        const result = await runtime.command(item.sessionId, { kind: 'acknowledge-result', turnEndSeq: item.turnEndSeq })
        if (result.ok) progressed = true
      }
      current = await runtime.previewPolicy(draftNow)
      if (!progressed) break
    }
    setAcknowledging(false)
    const remaining = current === null ? null : current.heldTotal
    if (current !== null) setPreview(current)
    setMessage(remaining === 0 ? t('settings.preview.acknowledged') : t('settings.preview.ackFailed', { n: remaining ?? preview.heldTotal }))
    setPreviewTick(value => value + 1)
  }
  const titleOf = (id: string) => runtime.sessions.getSnapshot().byId[id]?.displayTitle ?? id.slice(0, 8)
  const defaultValue = draft.enabled && validDays(draft.days) ? t('settings.daysValue', { n: Number(draft.days) }) : t('settings.offValue')
  const ready = backend.status === 'ready'

  const skipSummary = (): string | null => {
    if (preview === null) return null
    const counts = new Map<string, number>()
    for (const [skip, n] of Object.entries(preview.skips)) {
      if (skip === 'not-due' || skip === 'unacknowledged-failure' || skip === 'unacknowledged-result' || skip === 'policy-off' || skip === 'archived') continue
      const key = UNKNOWN_SKIPS.has(skip) ? 'unknown' : skip
      counts.set(key, (counts.get(key) ?? 0) + n)
    }
    const parts = SKIP_ORDER.filter(key => (counts.get(key) ?? 0) > 0).map(key => `${t(`skip.${key}` as Key)} ${counts.get(key)}`)
    return parts.length === 0 ? null : t('settings.preview.skips', { list: parts.join(' · ') })
  }

  return (
    <div className="t3sb-settings" data-testid="t3-settings-page">
      <section>
        <h3>{t('settings.storage')}</h3>
        <p className="t3sb-dialog-note" data-testid="t3-backend-note">
          {storage}
          {backend.kind === 'local' && backend.failure !== null && backend.failure !== 'transient' && (
            <> {t(`settings.backend.failure.${backend.failure}` as Key)}</>
          )}
        </p>
        {slot.known && !slot.active && (
          <p className="t3sb-dialog-note t3sb-warning" role="status" data-testid="t3-slot-note">
            {slot.winner === null ? t('settings.slot.shadowedUnknown') : t('settings.slot.shadowed', { name: slot.winner })}
          </p>
        )}
      </section>
      {host && (
        <section>
          <h3>{t('settings.autoSettleTitle')}</h3>
          <div className="t3sb-settings-row">
            <span>{t('settings.autoSettle')}</span>
            <Switch checked={draft.enabled} onChange={(next) => { update({ enabled: next }) }} label={t('settings.autoSettle')} />
          </div>
          <div className="t3sb-settings-row">
            <span className={draft.enabled ? undefined : 't3sb-muted'}>{t('settings.daysLabel')}</span>
            <Input className="t3sb-settings-days" type="number" min={MIN_AUTO_SETTLE_DAYS} max={MAX_AUTO_SETTLE_DAYS} step={1} value={draft.days}
              disabled={!draft.enabled} aria-label={t('settings.daysLabel')} aria-invalid={draft.enabled && !validDays(draft.days)}
              onChange={(event) => { update({ days: event.target.value }) }} />
          </div>
          <div className="t3sb-settings-row">
            <span>{t('settings.keepFailures')}</span>
            <Switch checked={draft.keepFailures} onChange={(next) => { update({ keepFailures: next }) }} label={t('settings.keepFailures')} />
          </div>
          <div className="t3sb-settings-row">
            <span>{t('settings.keepResults')}</span>
            <Switch checked={draft.keepResults} onChange={(next) => { update({ keepResults: next }) }} label={t('settings.keepResults')} />
          </div>

          {workspaces.items.length > 0 && (
            <div className="t3sb-settings-group" data-testid="t3-workspace-policies">
              <h4>{t('settings.workspaces')}</h4>
              <p className="t3sb-dialog-note">{t('settings.workspacesNote')}</p>
              {workspaces.items.map((workspace) => {
                const override = draft.overrides[workspace.workspaceId] ?? { mode: 'inherit' as const, days: '' }
                const name = workspace.title || workspace.path
                return (
                  <div key={workspace.workspaceId} className="t3sb-settings-row" data-workspace-policy={workspace.workspaceId}>
                    <span className="t3sb-settings-workspace" title={workspace.path}>{name}</span>
                    <span className="t3sb-settings-controls">
                      <select className="t3sb-select" value={override.mode} aria-label={t('settings.workspace.aria', { name })}
                        onChange={(event) => {
                          const mode = event.target.value as OverrideMode
                          updateOverride(workspace.workspaceId, { mode, days: override.days === '' ? (validDays(draft.days) ? draft.days : '7') : override.days })
                        }}>
                        <option value="inherit">{t('settings.workspace.inherit', { value: defaultValue })}</option>
                        <option value="custom">{t('settings.workspace.custom')}</option>
                        <option value="off">{t('settings.workspace.off')}</option>
                      </select>
                      {override.mode === 'custom' && (
                        <Input className="t3sb-settings-days" type="number" min={MIN_AUTO_SETTLE_DAYS} max={MAX_AUTO_SETTLE_DAYS} step={1}
                          value={override.days} aria-label={t('settings.workspace.days', { name })} aria-invalid={!validDays(override.days)}
                          onChange={(event) => { updateOverride(workspace.workspaceId, { days: event.target.value }) }} />
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="t3sb-settings-group" data-testid="t3-policy-preview" aria-live="polite">
            <h4>{t('settings.preview')}</h4>
            {preview === null ? <p className="t3sb-dialog-note">{t('settings.preview.unavailable')}</p> : (
              <>
                <p className="t3sb-dialog-note" data-preview="due">{t('settings.preview.due', { n: preview.due })}</p>
                <p className="t3sb-dialog-note" data-preview="next">
                  {preview.nextDeadline === null ? t('settings.preview.none') : t('settings.preview.next', {
                    title: titleOf(preview.nextDeadline.sessionId),
                    time: new Date(preview.nextDeadline.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                  })}
                </p>
                {preview.heldTotal > 0 && (
                  <div className="t3sb-settings-row" data-preview="held">
                    <span className="t3sb-dialog-note">{t('settings.preview.held', { n: preview.heldTotal })}</span>
                    <Button variant="outline" size="sm" disabled={!ready || acknowledging} onClick={() => { void acknowledgeAll() }}>
                      {t('settings.preview.ackAll')}
                    </Button>
                  </div>
                )}
                {skipSummary() !== null && <p className="t3sb-dialog-note t3sb-muted" data-preview="skips">{skipSummary()}</p>}
              </>
            )}
          </div>

          <div className="t3sb-settings-actions">
            {message !== null && <span role="status">{message}</span>}
            <Button variant="primary" size="sm" disabled={!ready || pending === null} onClick={() => { void save() }}>
              {t('settings.save')}
            </Button>
          </div>
        </section>
      )}
      {host && (
        <section>
          <h3>{t('settings.history')}</h3>
          {history.length === 0 ? <p className="t3sb-dialog-note">{t('settings.historyEmpty')}</p> : (
            <ul className="t3sb-history">
              {history.map(entry => (
                <li key={`${entry.at}-${entry.sessionId}-${entry.to}`}>
                  <span className="t3sb-history-title">{titleOf(entry.sessionId)}</span>
                  <time dateTime={new Date(entry.at).toISOString()}>
                    {new Date(entry.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </time>
                  <span className="t3sb-history-detail">
                    {t(`state.${entry.from}` as Key)} → {t(`state.${entry.to}` as Key)} · {t(reasonKey(entry.reason))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
