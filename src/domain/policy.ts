/**
 * Policy scope resolution (time-policy spec §2): Host default → Workspace
 * override → Session exemption, plus the grace bookkeeping that keeps a
 * scope change from settling long-idle sessions at once. Pure functions.
 */
import type { ActivitySummary, TimePolicy, TurnEndKind } from './types.ts'

export type PolicySource = 'host' | 'workspace'

export interface EffectivePolicy {
  /** Effective window in days, or null when off for this scope. */
  readonly days: number | null
  /** Where the value comes from: the Host default, or the session's workspace override. */
  readonly source: PolicySource
  /** The session's workspace (null when it belongs to none). */
  readonly workspaceId: string | null
  /** Stable identity: equal identities mean the same rule applies. */
  readonly identity: string
}

/**
 * Resolve the rule for a session in `workspaceId`. In Harness 0.2.2-rc.1 a
 * session belongs to at most one workspace (membership requires its header
 * cwd to equal the workspace's unique canonical path), so no separate
 * `policyWorkspaceId` choice exists.
 */
export function effectivePolicy(policy: Pick<TimePolicy, 'autoSettleAfterDays' | 'workspaceOverrides'>, workspaceId: string | null): EffectivePolicy {
  const override = workspaceId === null ? undefined : policy.workspaceOverrides[workspaceId]
  if (override === undefined) {
    return { days: policy.autoSettleAfterDays, source: 'host', workspaceId, identity: `host:${policy.autoSettleAfterDays ?? 'off'}` }
  }
  const days = override.mode === 'off' ? null : override.days
  return { days, source: 'workspace', workspaceId, identity: `workspace:${workspaceId}:${days ?? 'off'}` }
}

/** Enabling a rule or shortening its window: affected sessions get a fresh grace window. */
export function isStricter(before: number | null, after: number | null): boolean {
  return after !== null && (before === null || after < before)
}

/**
 * Workspaces whose effective window became stricter between two policies
 * (an override added, removed, or changed; or the inherited Host default
 * changed for a workspace that has an override in either version).
 * Workspaces that inherit in both versions follow the Host grace instead.
 */
export function stricterWorkspaces(before: TimePolicy, after: TimePolicy): string[] {
  const ids = new Set([...Object.keys(before.workspaceOverrides), ...Object.keys(after.workspaceOverrides)])
  return [...ids].filter(id => isStricter(effectivePolicy(before, id).days, effectivePolicy(after, id).days))
}

/**
 * Start of a session's grace window: its own record, the Host grace when it
 * follows the Host default, its workspace's grace when it is a member, and a
 * per-session grace set when its membership (and so its rule) changed.
 */
export function graceSince(input: {
  readonly recordSince: number
  readonly source: PolicySource
  readonly hostSince: number
  readonly workspaceSince: number | undefined
  readonly sessionSince: number | undefined
}): number {
  return Math.max(
    input.recordSince,
    input.source === 'host' ? input.hostSince : 0,
    input.workspaceSince ?? 0,
    input.sessionSince ?? 0,
  )
}

/**
 * Abnormal result: anything but a completed or user-cancelled turn. Blocked,
 * max-tokens, interrupted and unknown reasons count, as the spec requires.
 */
export function isAbnormalEnd(reason: TurnEndKind): boolean {
  return reason !== 'completed' && reason !== 'aborted' && reason !== 'forked'
}

/** The latest result when it is newer than the shared acknowledgement, else null. */
export function unacknowledgedResult(
  summary: ActivitySummary, acknowledgedSeq: number | null,
): { readonly seq: number; readonly abnormal: boolean } | null {
  const end = summary.lastTurnEnd
  if (end === null || (acknowledgedSeq !== null && end.seq <= acknowledgedSeq)) return null
  return { seq: end.seq, abnormal: isAbnormalEnd(end.reason) }
}

/** Which keep-unacknowledged protection, if any, holds this result. */
export function heldResult(
  policy: Pick<TimePolicy, 'keepUnacknowledgedFailures' | 'keepUnacknowledgedResults'>,
  summary: ActivitySummary, acknowledgedSeq: number | null,
): 'unacknowledged-failure' | 'unacknowledged-result' | null {
  const result = unacknowledgedResult(summary, acknowledgedSeq)
  if (result === null) return null
  if (result.abnormal && (policy.keepUnacknowledgedFailures || policy.keepUnacknowledgedResults)) return 'unacknowledged-failure'
  if (policy.keepUnacknowledgedResults) return 'unacknowledged-result'
  return null
}
