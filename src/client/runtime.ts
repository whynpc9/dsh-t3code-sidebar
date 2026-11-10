/**
 * The object the Client `apply` hands to the slot component: observable
 * sources plus actions. Components never touch `ctx` directly.
 */
import type { CommandAction, CommandResult, PolicyResult } from '../contracts/schema.ts'
import type { BackendState } from './backend.ts'
import type { Key } from './locales.ts'
import type { SessionsSnapshot, StatusSnapshot, WorkspacesSnapshot } from './model.ts'
import type { Readable, Store } from './store.ts'

export type ViewMode = 'tasks' | 'projects'

export interface Prefs {
  readonly view: ViewMode
  /** Workspace id, 'ungrouped', or null for all projects. */
  readonly scope: string | null
  /** Collapsed state per view: key `${view}:${sectionOrGroup}` → collapsed. */
  readonly collapsed: Readonly<Record<string, boolean>>
  /** Per-browser read marker: last turn-end seq seen in the main view. */
  readonly lastSeen: Readonly<Record<string, number>>
  readonly includeContent: boolean
}

export const DEFAULT_PREFS: Prefs = {
  view: 'tasks',
  scope: null,
  collapsed: {},
  lastSeen: {},
  includeContent: false,
}

export interface SearchResult {
  readonly ids: readonly string[]
  readonly hasMore: boolean
}

export interface Runtime {
  readonly sessions: Readable<SessionsSnapshot>
  readonly workspaces: Readable<WorkspacesSnapshot>
  readonly status: Readable<StatusSnapshot>
  readonly backend: Readable<BackendState>
  readonly prefs: Store<Prefs>
  readonly locale: Readable<unknown>
  readonly t: (key: Key, params?: Record<string, unknown>) => string
  readonly searchLimit: number
  open(sessionId: string): void
  startSession(workspaceId?: string): void
  unarchive(sessionId: string): void
  openSessionMenu(sessionId: string, displayTitle: string, point: { x: number; y: number }): void
  command(sessionId: string, action: CommandAction): Promise<CommandResult>
  setPolicy(days: number | null, keepFailures: boolean): Promise<PolicyResult>
  listTransitions(limit: number): Promise<readonly { at: number; sessionId: string; from: string; to: string; reason: string }[]>
  search(query: string, signal: AbortSignal): Promise<SearchResult>
  createWorkspace(path: string): Promise<void>
  renameWorkspace(workspaceId: string, title: string): Promise<void>
  deleteWorkspace(workspaceId: string): Promise<void>
  /** Host-native directory chooser; null when cancelled or unavailable. */
  pickDirectory(): Promise<string | null>
  /** Snooze-with-custom-time requests raised from the context menu. */
  readonly snoozeRequest: Store<string | null>
  readonly notice: Store<{ readonly text: string; readonly seq: number } | null>
}
