/**
 * This plugin's configuration, rendered on its own page under Plugins
 * (`plugins.bundle.config`, keyed by the package name): where task state is
 * stored, the automatic-settle policy, and the recent automatic changes.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Key } from '../locales.ts'
import type { Runtime, Transition } from '../runtime.ts'

function reasonKey(reason: string): Key {
  if (reason === 'snooze-expired' || reason === 'idle-timeout') return `reason.${reason}`
  if (reason.startsWith('manual:')) return 'reason.manual'
  return 'reason.activity'
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
  const host = backend.kind === 'host'
  const [enabled, setEnabled] = useState(backend.policy.autoSettleAfterDays !== null)
  const [days, setDays] = useState(String(backend.policy.autoSettleAfterDays ?? 7))
  const [keepFailures, setKeepFailures] = useState(backend.policy.keepUnacknowledgedFailures)
  const [message, setMessage] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly Transition[]>([])

  // Follow policy changes made elsewhere (another window, a reconnect) while this page is open.
  useEffect(() => {
    setEnabled(backend.policy.autoSettleAfterDays !== null)
    setDays(String(backend.policy.autoSettleAfterDays ?? 7))
    setKeepFailures(backend.policy.keepUnacknowledgedFailures)
  }, [backend.policy.revision, backend.policy.autoSettleAfterDays, backend.policy.keepUnacknowledgedFailures])

  useEffect(() => {
    if (!host || view !== 'page') return
    let live = true
    void runtime.listTransitions(20).then((entries) => { if (live) setHistory(entries) })
    return () => { live = false }
  }, [host, view, runtime, backend.policy.revision])

  const storage = host ? t('settings.backend.host')
    : backend.kind === 'local' ? t('settings.backend.local') : t('settings.backend.connecting')
  if (view === 'summary') return <>{storage}</>

  const parsedDays = Number(days)
  const daysValid = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 90
  const save = async () => {
    const result = await runtime.setPolicy(enabled ? parsedDays : null, keepFailures)
    if (result.ok) { setMessage(t('settings.saved')); return }
    const key = `error.${result.code}` as Key
    setMessage(t(key) === key ? t('error.generic', { code: result.code }) : t(key))
  }
  const titleOf = (id: string) => runtime.sessions.getSnapshot().byId[id]?.displayTitle ?? id.slice(0, 8)

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
      </section>
      {host && (
        <section>
          <h3>{t('settings.autoSettleTitle')}</h3>
          <div className="t3sb-settings-row">
            <span>{t('settings.autoSettle')}</span>
            <Switch checked={enabled} onChange={(next) => { setEnabled(next); setMessage(null) }} label={t('settings.autoSettle')} />
          </div>
          <div className="t3sb-settings-row">
            <span className={enabled ? undefined : 't3sb-muted'}>{t('settings.daysLabel')}</span>
            <Input className="t3sb-settings-days" type="number" min={1} max={90} step={1} value={days} disabled={!enabled}
              aria-label={t('settings.daysLabel')} aria-invalid={enabled && !daysValid}
              onChange={(event) => { setDays(event.target.value); setMessage(null) }} />
          </div>
          <div className="t3sb-settings-row">
            <span className={enabled ? undefined : 't3sb-muted'}>{t('settings.keepFailures')}</span>
            <Switch checked={keepFailures} disabled={!enabled} onChange={(next) => { setKeepFailures(next); setMessage(null) }} label={t('settings.keepFailures')} />
          </div>
          <div className="t3sb-settings-actions">
            {message !== null && <span role="status">{message}</span>}
            <Button variant="primary" size="sm" disabled={backend.status !== 'ready' || (enabled && !daysValid)} onClick={() => { void save() }}>
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
