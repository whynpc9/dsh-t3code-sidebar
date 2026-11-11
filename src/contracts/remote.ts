/**
 * Hand-maintained Typert Remote spec for `ctx.remote.t3Sidebar` — the same
 * artifact shape `@deepseek-ai/dsh-typert-generator` emits, built from the zod
 * schemas in `schema.ts`. The Client mounts it with `ctx.remote.$mount()`;
 * the Host service is dispatched through the Gateway's SRC marker path and
 * validates every input with the same schemas.
 *
 * SRC dispatch reads parameter names from the live Host function, so Host
 * parameter names must equal the wire names below; they carry a `t3` prefix
 * so bundler renaming never touches them, and the build verifies the match.
 */
import { z, type ZodType } from 'zod'
import {
  CommandInputSchema, CommandResultSchema, FollowEventSchema, PolicyInputSchema, PolicyResultSchema,
  SnapshotSchema, TransitionSchema,
} from './schema.ts'

export const PACKAGE = 'dsh-t3code-sidebar'
export const NAMESPACE = 't3Sidebar'
export const SERVICE_KEY = 't3Sidebar'

/** Remote failure code the Host throws when the Client speaks another protocol version. */
export const PROTOCOL_MISMATCH_CODE = 't3Sidebar/protocol-mismatch'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    't3Sidebar/protocol-mismatch': { readonly client: number; readonly host: number }
  }
}

const strictObject = (schema: ZodType): ZodType =>
  schema instanceof z.ZodObject ? (schema as z.ZodObject).strict() : schema

const codec = (schema: ZodType, symbol: string) => ({
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE}#${symbol}`,
  create: () => schema,
})

const param = (name: string, schema: ZodType, symbol: string) => ({
  name,
  source: 'json' as const,
  codec: codec(schema, symbol),
  strictCodec: codec(strictObject(schema), symbol),
})

const direct = { kind: 'direct' as const }

/** The `TypertRemoteSpec` for this package (protocol v1). */
export const REMOTE_SPEC = {
  package: PACKAGE,
  methods: {
    [`${NAMESPACE}/getSnapshot`]: {
      service: SERVICE_KEY,
      invocation: direct,
      description: 'Complete task-state baseline for the owner.',
      parameters: [param('t3ProtocolVersion', z.number(), 'ProtocolVersion')],
      result: codec(SnapshotSchema, 'Snapshot'),
    },
    [`${NAMESPACE}/follow`]: {
      service: SERVICE_KEY,
      invocation: direct,
      mode: 'stream' as const,
      description: 'One baseline followed by ordered deltas; reconnect always starts from a new baseline.',
      parameters: [param('t3ProtocolVersion', z.number(), 'ProtocolVersion')],
      cancellation: { parameter: 'signal' as const },
      result: codec(FollowEventSchema, 'FollowEvent'),
    },
    [`${NAMESPACE}/command`]: {
      service: SERVICE_KEY,
      invocation: direct,
      description: 'Apply one idempotent, revision-checked task command.',
      parameters: [param('t3CommandInput', CommandInputSchema, 'CommandInput')],
      result: codec(CommandResultSchema, 'CommandResult'),
    },
    [`${NAMESPACE}/setPolicy`]: {
      service: SERVICE_KEY,
      invocation: direct,
      description: 'Replace the automatic-settle policy (revision-checked).',
      parameters: [param('t3PolicyInput', PolicyInputSchema, 'PolicyInput')],
      result: codec(PolicyResultSchema, 'PolicyResult'),
    },
    [`${NAMESPACE}/listTransitions`]: {
      service: SERVICE_KEY,
      invocation: direct,
      description: 'Most recent automatic and manual state transitions (no message content).',
      parameters: [param('t3Limit', z.number().int().min(1).max(1000), 'Limit')],
      result: codec(z.array(TransitionSchema), 'Transitions'),
    },
  },
} as const
