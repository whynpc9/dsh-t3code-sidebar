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
  receipts: z.array(z.object({ commandId: z.string(), revision: z.number(), digest: z.string() })).readonly(),
})

export const TimePolicySchema = z.object({
  revision: z.number().int().nonnegative(),
  autoSettleAfterDays: z.number().int().min(1).max(90).nullable(),
  keepUnacknowledgedFailures: z.boolean(),
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
  z.object({ kind: z.literal('snooze'), until: z.number().int() }),
  z.object({ kind: z.literal('settle') }),
  z.object({ kind: z.literal('reopen') }),
  z.object({ kind: z.literal('policy-override'), override: z.enum(['inherit', 'disabled']) }),
])

/**
 * Client-observed pending interactions, sent with commands because only the
 * browser's `uiSession` sees live approvals. The Host treats them as a lower
 * bound: they can block a command, never authorize one.
 */
export const PendingSignalSchema = z.object({ source: z.string(), key: z.string(), kind: z.string() })

export const CommandInputSchema = z.object({
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

export const PolicyInputSchema = z.object({
  protocolVersion: z.number(),
  expectedRevision: z.number().int().nonnegative(),
  autoSettleAfterDays: z.number().int().min(1).max(90).nullable(),
  keepUnacknowledgedFailures: z.boolean(),
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
export type Capabilities = z.infer<typeof CapabilitiesSchema>
