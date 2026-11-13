/**
 * Domain vocabulary shared by the Host task-state service, the browser-local
 * fallback backend, and the UI selectors. Everything here is plain data: no
 * Harness imports, no I/O, so both runtime faces and the tests can use it.
 */

/** The five task sections. Archived is a separate filter, never a placement. */
export type Placement = 'pinned' | 'active' | 'working' | 'snoozed' | 'settled'

export const PLACEMENTS: readonly Placement[] = ['pinned', 'active', 'working', 'snoozed', 'settled']

/** A fact that may be unknown; unknown is never treated as "empty" or "idle". */
export type Known<T> = { readonly known: true; readonly value: T } | { readonly known: false }

export const known = <T>(value: T): Known<T> => ({ known: true, value })
export const unknown: Known<never> = { known: false }

/** Why a turn ended, as recorded in the session journal (`turn/end.reason.kind`). */
export type TurnEndKind =
  | 'completed'
  | 'error'
  | 'aborted'
  | 'blocked'
  | 'max-tokens'
  | 'interrupted'
  | 'forked'
  | (string & {})

/** Outcome category shown on the row. */
export type ResultKind = 'success' | 'failure' | 'cancelled' | 'needs-check'

export function resultKindOf(reason: TurnEndKind): ResultKind {
  switch (reason) {
    case 'completed': return 'success'
    case 'error': return 'failure'
    case 'aborted': return 'cancelled'
    default: return 'needs-check'
  }
}

/**
 * Durable activity summary the Host folds from committed session events.
 * Times are Host epoch milliseconds; `seq` values are the session journal's.
 */
export interface ActivitySummary {
  /** Latest human `user/message` (source.kind === 'user'). */
  readonly lastUserInputAt: number | null
  readonly lastTurnStartAt: number | null
  readonly lastTurnStartSeq: number | null
  readonly lastTurnEnd: { readonly seq: number; readonly at: number; readonly reason: TurnEndKind } | null
}

export const EMPTY_ACTIVITY: ActivitySummary = {
  lastUserInputAt: null,
  lastTurnStartAt: null,
  lastTurnStartSeq: null,
  lastTurnEnd: null,
}

/** One unresolved interaction (approval, question, …). Keys compare only within `source`. */
export interface PendingSignal {
  readonly source: string
  readonly key: string
  readonly kind: string
}

/**
 * Everything the placement function needs about one session's live state.
 * `running` covers the session's own turn; `activity` lists any Host-reported
 * activity family (turn, subagent, job, schedule) — unknown when the Host could
 * not answer.
 */
export interface TaskFacts {
  readonly running: Known<boolean>
  readonly pending: Known<readonly PendingSignal[]>
  readonly activity: Known<readonly string[]>
  readonly summary: ActivitySummary
  /**
   * Whether `summary` is known to include the session's latest result. False
   * when results may predate installation or have been written while the
   * Host half was not running and the stored log has not been replayed yet.
   * Omitted: known.
   */
  readonly resultHistoryKnown?: boolean
}

/** Native Harness state; the plugin never stores pin/archive itself. */
export interface NativeState {
  readonly pinned: boolean
  readonly archived: boolean
}

export type SettleReason = 'manual' | 'idle-timeout'

/** Plugin-owned disposition ("parking") of one session. */
export type Disposition =
  | { readonly kind: 'normal' }
  | {
    readonly kind: 'snoozed'
    readonly until: number
    readonly setAt: number
    /** Pending keys that existed when snoozing; they do not wake the task again. */
    readonly baselinePending: readonly string[]
    /** Turn-end seq at snooze time; a later failure wakes the task. */
    readonly baselineTurnEndSeq: number | null
    readonly baselineUserInputAt: number | null
  }
  | {
    readonly kind: 'settled'
    readonly reason: SettleReason
    /** When the settle was actually committed (never back-filled). */
    readonly enteredAt: number
    readonly baselineTurnStartSeq: number | null
    readonly baselineUserInputAt: number | null
    readonly baselinePending: readonly string[]
    /** Audit facts for idle-timeout settles. */
    readonly anchorAt?: number
    readonly deadline?: number
    readonly policyRevision?: number
  }

/** Per-session automatic-settle override. */
export type SessionPolicyOverride = 'inherit' | 'disabled'

/** Durable plugin record for one session. */
export interface TaskRecord {
  readonly sessionId: string
  readonly revision: number
  readonly disposition: Disposition
  /**
   * Set by a manual reopen ("do not auto-settle until new activity"); cleared
   * once human input or a turn start newer than its baseline arrives.
   */
  readonly autoSettleHold: { readonly baselineUserInputAt: number | null; readonly baselineTurnStartSeq: number | null } | null
  readonly policyOverride: SessionPolicyOverride
  /** Start of the session's automatic-settle grace window (install / re-enable). */
  readonly policyEligibleSince: number
  /** Last time a Snooze ended (expiry or manual wake); restarts the idle window. */
  readonly lastSnoozeWakeAt: number | null
  /** Folded activity; persisted so cold sessions keep their anchors across restarts. */
  readonly activity: ActivitySummary
  /**
   * Turn-end seq of the latest result acknowledged with "Acknowledge result"
   * (shared across windows, unlike the per-browser read marker). Results up to
   * it no longer hold the session under the keep-unacknowledged protections.
   */
  readonly resultAcknowledgedSeq: number | null
  /** Most recent accepted command ids → resulting revision (idempotent retries). */
  readonly receipts: readonly { readonly commandId: string; readonly revision: number; readonly digest: string }[]
}

export function emptyRecord(sessionId: string, now: number): TaskRecord {
  return {
    sessionId,
    revision: 0,
    disposition: { kind: 'normal' },
    autoSettleHold: null,
    policyOverride: 'inherit',
    policyEligibleSince: now,
    lastSnoozeWakeAt: null,
    activity: EMPTY_ACTIVITY,
    resultAcknowledgedSeq: null,
    receipts: [],
  }
}

/**
 * Workspace-level override of the Host default (time-policy spec §2). An
 * absent entry inherits; `off` and `custom` are explicit, so "off" never
 * doubles as "inherit".
 */
export type WorkspacePolicyOverride =
  | { readonly mode: 'off' }
  | { readonly mode: 'custom'; readonly days: number }

/** Automatic-settle policy (v0.1 subset of the time-policy spec). */
export interface TimePolicy {
  readonly revision: number
  /** Host default: whole days 1..90, or null when automatic settling is off. */
  readonly autoSettleAfterDays: number | null
  /** Abnormal results (failure, blocked, max tokens, interrupted, unknown) hold the session until acknowledged. */
  readonly keepUnacknowledgedFailures: boolean
  /** Every result holds the session until acknowledged. */
  readonly keepUnacknowledgedResults: boolean
  /** Per-workspace overrides keyed by workspace id; absent means inherit the Host default. */
  readonly workspaceOverrides: Readonly<Record<string, WorkspacePolicyOverride>>
}

export const MIN_AUTO_SETTLE_DAYS = 1
export const MAX_AUTO_SETTLE_DAYS = 90

export const DEFAULT_AUTO_SETTLE_DAYS = 7

export const DAY_MS = 24 * 60 * 60 * 1000
