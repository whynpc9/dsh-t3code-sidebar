/**
 * Wire and storage schemas for the `t3Sidebar` namespace (protocol v1).
 * One zod source feeds the Client Remote codecs, the Host input validation and
 * the storage-domain record schema, so the three cannot drift.
 */
import { z } from 'zod'

export const PROTOCOL_VERSION = 1

const nullableNumber = z.number().nullable()

export const ActivitySummarySchema = z.object({
  lastUserInputAt: nullableNumber,
  lastTurnStartAt: nullableNumber,
  lastTurnStartSeq: nullableNumber,
  lastTurnEnd: z.object({ seq: z.number(), at: z.number(), reason: z.string() }).nullable(),
})

export const DispositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('normal') }),
  z.object({
    kind: z.literal('snoozed'),
    until: z.number(),
    setAt: z.number(),
    baselinePending: z.array(z.string()).readonly(),
    baselineTurnEndSeq: nullableNumber,
    baselineUserInputAt: nullableNumber,
  }),
  z.object({
    kind: z.literal('settled'),
    reason: z.enum(['manual', 'idle-timeout']),
    enteredAt: z.number(),
    baselineTurnStartSeq: nullableNumber,
    baselineUserInputAt: nullableNumber,
    baselinePending: z.array(z.string()).readonly(),
    anchorAt: z.number().optional(),
    deadline: z.number().optional(),
    policyRevision: z.number().optional(),
  }),
])

export const TaskRecordSchema = z.object({
  sessionId: z.string(),
  revision: z.number().int().nonnegative(),
  disposition: DispositionSchema,
  autoSettleHold: z.object({ baselineUserInputAt: nullableNumber, baselineTurnStartSeq: nullableNumber }).nullable(),
  policyOverride: z.enum(['inherit', 'disabled']),
  policyEligibleSince: z.number(),
  lastSnoozeWakeAt: nullableNumber,
  activity: ActivitySummarySchema,
  /** Absent in records written before result acknowledgement existed. */
  resultAcknowledgedSeq: nullableNumber.default(null),
  receipts: z.array(z.object({ commandId: z.string(), revision: z.number(), digest: z.string() })).readonly(),
})

const DaysSchema = z.number().int().min(1).max(90)

/** Absent key = inherit the Host default; `off` and `custom` are explicit. */
export const WorkspacePolicyOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }),
  z.object({ mode: z.literal('custom'), days: DaysSchema }),
])

export const TimePolicySchema = z.object({
  revision: z.number().int().nonnegative(),
  autoSettleAfterDays: DaysSchema.nullable(),
  keepUnacknowledgedFailures: z.boolean(),
  /** Defaults keep policies stored before these fields existed readable. */
  keepUnacknowledgedResults: z.boolean().default(false),
  workspaceOverrides: z.record(z.string(), WorkspacePolicyOverrideSchema).default({}),
})

/** Per-session view the Host publishes: its record plus Host-only facts. */
export const TaskViewSchema = z.object({
  sessionId: z.string(),
  record: TaskRecordSchema,
  /** Host-reported activity families (turn/subagent/job/schedule), or null when unknown. */
  activity: z.array(z.string()).nullable(),
  /** Next automatic-settle deadline, or null when not applicable. */
  autoSettleDeadline: nullableNumber,
  autoSettleSkip: z.string().nullable(),
})

export const CapabilitiesSchema = z.object({
  /** Host answers `workspace/session-activity` (turn, subagent, job, schedule). */
  hostActivity: z.boolean(),
  /** Host folds committed session events into activity summaries. */
  sessionEvents: z.boolean(),
  /** Host can see pending approvals/questions (false: only the browser can). */
  hostPending: z.boolean(),
})

export const SnapshotSchema = z.object({
  protocolVersion: z.number(),
  installationId: z.string(),
  epoch: z.string(),
  streamSeq: z.number(),
  dataRevision: z.number(),
  serverNow: z.number(),
  capabilities: CapabilitiesSchema,
  policy: TimePolicySchema,
  tasks: z.array(TaskViewSchema),
})

export const FollowEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('baseline'), snapshot: SnapshotSchema }),
  z.object({
    kind: z.literal('delta'),
    epoch: z.string(),
    streamSeq: z.number(),
    dataRevision: z.number(),
    serverNow: z.number(),
    tasks: z.array(TaskViewSchema),
    policy: TimePolicySchema.nullable(),
  }),
])

export const CommandActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('snooze'), until: z.number().int() }),
  z.strictObject({ kind: z.literal('settle') }),
  z.strictObject({ kind: z.literal('reopen') }),
  z.strictObject({ kind: z.literal('policy-override'), override: z.enum(['inherit', 'disabled']) }),
  /** Shared "I have seen this result" for the keep-unacknowledged protections (time-policy spec §3). */
  z.strictObject({ kind: z.literal('acknowledge-result'), turnEndSeq: z.number().int().nonnegative() }),
])

/**
 * Client-observed pending interactions, sent with commands because only the
 * browser's `uiSession` sees live approvals. The Host treats them as a lower
 * bound: they can block a command, never authorize one.
 */
export const PendingSignalSchema = z.object({ source: z.string(), key: z.string(), kind: z.string() })

export const CommandInputSchema = z.strictObject({
  protocolVersion: z.number(),
  commandId: z.string().min(8).max(80),
  sessionId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  action: CommandActionSchema,
  observedPending: z.array(PendingSignalSchema).nullable(),
})

export const ErrorCodeSchema = z.enum([
  'UNSUPPORTED_HOST', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'SESSION_ACTIVE', 'PENDING_APPROVAL', 'PINNED',
  'ARCHIVED', 'PENDING_INPUT', 'BASELINE_PENDING', 'INVALID_TIME', 'STORAGE_UNAVAILABLE', 'PROTOCOL_MISMATCH',
])

export const CommandResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), task: TaskViewSchema, dataRevision: z.number(), replayed: z.boolean() }),
  z.object({ ok: z.literal(false), code: ErrorCodeSchema, message: z.string(), task: TaskViewSchema.nullable() }),
])

export const PolicyInputSchema = z.strictObject({
  protocolVersion: z.number(),
  expectedRevision: z.number().int().nonnegative(),
  autoSettleAfterDays: DaysSchema.nullable(),
  keepUnacknowledgedFailures: z.boolean(),
  /** Omitted: keep the stored value. */
  keepUnacknowledgedResults: z.boolean().optional(),
  /** Omitted: keep the stored overrides; otherwise replaces all of them. */
  workspaceOverrides: z.record(z.string(), WorkspacePolicyOverrideSchema).optional(),
})

/** Every editable policy field (a settings draft). */
export const PolicyDraftSchema = z.object({
  autoSettleAfterDays: DaysSchema.nullable(),
  keepUnacknowledgedFailures: z.boolean(),
  keepUnacknowledgedResults: z.boolean(),
  workspaceOverrides: z.record(z.string(), WorkspacePolicyOverrideSchema),
})

/** `previewPolicy`: evaluate the current policy, or an unsaved draft, without writing. */
export const PreviewInputSchema = z.object({
  protocolVersion: z.number(),
  draft: PolicyDraftSchema.nullable(),
})

export const HeldResultSchema = z.object({
  sessionId: z.string(),
  turnEndSeq: z.number(),
  reason: z.enum(['unacknowledged-failure', 'unacknowledged-result']),
})

export const PolicyPreviewSchema = z.object({
  /** Revision of the stored policy the preview started from. */
  policyRevision: z.number(),
  evaluatedAt: z.number(),
  /** Top-level sessions evaluated. */
  sessions: z.number(),
  /** Sessions that would settle at the next sweep (at most a minute away). */
  due: z.number(),
  /** Earliest future deadline among sessions only waiting for time to pass. */
  nextDeadline: z.object({ sessionId: z.string(), at: z.number() }).nullable(),
  /** Count per skip reason (`AutoSettleSkip`), excluding due sessions. */
  skips: z.record(z.string(), z.number()),
  /** Results that hold a session under a keep-unacknowledged protection (first 200). */
  held: z.array(HeldResultSchema),
  heldTotal: z.number(),
})

export const PolicyResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), policy: TimePolicySchema }),
  z.object({ ok: z.literal(false), code: ErrorCodeSchema, message: z.string(), policy: TimePolicySchema }),
])

export const TransitionSchema = z.object({
  id: z.string(),
  at: z.number(),
  sessionId: z.string(),
  from: z.string(),
  to: z.string(),
  reason: z.string(),
  policyRevision: nullableNumber,
  anchorAt: nullableNumber,
  deadline: nullableNumber,
})

export type Snapshot = z.infer<typeof SnapshotSchema>
export type TaskView = z.infer<typeof TaskViewSchema>
export type FollowEvent = z.infer<typeof FollowEventSchema>
export type CommandInput = z.infer<typeof CommandInputSchema>
export type CommandAction = z.infer<typeof CommandActionSchema>
export type CommandResult = z.infer<typeof CommandResultSchema>
export type PolicyInput = z.infer<typeof PolicyInputSchema>
export type PolicyResult = z.infer<typeof PolicyResultSchema>
export type TransitionEntry = z.infer<typeof TransitionSchema>
export type PolicyDraftInput = z.infer<typeof PolicyDraftSchema>
export type PreviewInput = z.infer<typeof PreviewInputSchema>
export type PolicyPreview = z.infer<typeof PolicyPreviewSchema>
export type HeldResult = z.infer<typeof HeldResultSchema>
export type Capabilities = z.infer<typeof CapabilitiesSchema>
