/**
 * Narrow structural views of the Harness Host services this plugin consumes
 * (verified against @deepseek-ai/dsh 0.2.2-rc.1). Keeping them here isolates
 * preview-API drift to one adapter file; nothing else imports Harness types.
 */

export interface HostSessionHeader {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
}

export interface HostSession {
  readonly id: string
  readonly header?: HostSessionHeader
}

export interface HostSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

export interface HostSessionActivity {
  readonly kind: string
  readonly items?: readonly { readonly id: string; readonly label?: string }[]
}

export interface HostWorkspaceRegistry {
  readonly pinnedSessionIds: readonly string[]
  readonly archivedSessionIds: readonly string[]
}

/** A `read` handle onto one stored session's append-only event log. */
export interface HostSessionReadHandle {
  /** Fork-inherited leading events; they belong to the parent session's history. */
  readonly inheritedEventCount?: number
  read(offset?: number, length?: number, options?: { readonly signal?: AbortSignal }): Promise<{ readonly events: readonly HostSessionEvent[] }>
  close(): Promise<void>
}

export interface HostSessionPersistence {
  /**
   * `revision` is an opaque change token, comparable only within one service
   * instance: equal tokens mean an unchanged log, unequal tokens promise
   * nothing (a title event or a metadata-only touch changes it too).
   */
  list(): Promise<readonly { readonly header: HostSessionHeader; readonly revision?: unknown }[]>
  /** `read` access never takes ownership and works while another handle writes. */
  open?(id: string, access: 'read', options?: { readonly signal?: AbortSignal }): Promise<HostSessionReadHandle>
}

/** Answer of `sessionController.projections()`: exact values, migration hints, or absent. */
export type HostProjectionsValue =
  | { readonly kind: 'sequenced'; readonly asOfSeq: number; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: 'migration-required'; readonly values: Readonly<Record<string, unknown>> }
  | null

export interface HostSessionController {
  projections(request: { readonly sessionId: string }, signal: AbortSignal): Promise<HostProjectionsValue>
}

export interface HostLiveSessions {
  list(): readonly { readonly header: HostSessionHeader }[]
}

export interface DomainTable<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

export interface DomainGlobal<G> {
  get(): G
  set(value: G): Promise<void>
}

export interface OpenDomain<T, A, G> {
  table(name: 'tasks'): DomainTable<T>
  table(name: 'transitions'): DomainTable<A>
  readonly global: DomainGlobal<G>
  close(): Promise<void>
}

/** Pull a typed optional service without throwing when it is absent. */
export function optionalService<T>(ctx: { get(name: string): unknown }, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}
