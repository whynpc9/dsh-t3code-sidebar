/**
 * The object the Client `apply` hands to the slot components: observable
 * sources plus actions. Components never touch `ctx` directly.
 */
import type { CommandAction, PolicyPreview } from '../contracts/schema.ts'
import type { BackendState, CommandOutcome, PolicyDraft, PolicyOutcome } from './backend.ts'
import type { Key } from './locales.ts'
import type { ArchivedFilter, ContentHit, GroupBy, SessionsSnapshot, StatusSnapshot, WorkspacesSnapshot } from './model.ts'
import type { ShortcutRequests, SlotStatus } from './native-bridge.ts'
import type { Readable, Store } from './store.ts'

export interface Prefs {
  /** Session-list grouping; status sections by default. */
  readonly groupBy: GroupBy
  /** Archived-row visibility. */
  readonly archivedFilter: ArchivedFilter
  /** Explicit collapse state: `status:<section>` or `workspace:<group key>` → collapsed. */
  readonly collapsed: Readonly<Record<string, boolean>>
  /** Per-browser read marker: last turn-end seq seen in the main view. */
  readonly lastSeen: Readonly<Record<string, number>>
}

export const DEFAULT_PREFS: Prefs = {
  groupBy: 'status',
  archivedFilter: 'default',
  collapsed: {},
  lastSeen: {},
}

const GROUP_BY: readonly GroupBy[] = ['status', 'workspace', 'flat']
const ARCHIVED_FILTERS: readonly ArchivedFilter[] = ['default', 'show', 'only']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Read stored preferences, migrating the R0 alpha shape: `view: 'projects'`
 * becomes the workspace grouping, `tasks:<section>` collapse keys become
 * `status:<section>`, and the removed scope / content-search fields drop.
 */
export function migratePrefs(raw: unknown): Prefs {
  if (!isRecord(raw)) return DEFAULT_PREFS
  const groupBy = GROUP_BY.includes(raw['groupBy'] as GroupBy)
    ? raw['groupBy'] as GroupBy
    : raw['view'] === 'projects' ? 'workspace' : 'status'
  const archivedFilter = ARCHIVED_FILTERS.includes(raw['archivedFilter'] as ArchivedFilter)
    ? raw['archivedFilter'] as ArchivedFilter
    : 'default'
  const collapsed: Record<string, boolean> = {}
  if (isRecord(raw['collapsed'])) {
    for (const [key, value] of Object.entries(raw['collapsed'])) {
      if (typeof value !== 'boolean') continue
      if (key.startsWith('tasks:')) collapsed[`status:${key.slice('tasks:'.length)}`] = value
      else if (key.startsWith('status:') || key.startsWith('workspace:')) collapsed[key] = value
    }
  }
  const lastSeen: Record<string, number> = {}
  if (isRecord(raw['lastSeen'])) {
    for (const [key, value] of Object.entries(raw['lastSeen'])) if (typeof value === 'number') lastSeen[key] = value
  }
  return { groupBy, archivedFilter, collapsed, lastSeen }
}

export interface SearchPage {
  readonly items: readonly ContentHit[]
  readonly hasMore: boolean
}

export interface Transition {
  readonly at: number
  readonly sessionId: string
  readonly from: string
  readonly to: string
  readonly reason: string
}

/** A captured context-menu target, as `ctx.contextMenus.active` reports it. */
export interface MenuTarget {
  readonly kind: string
  readonly value: Readonly<Record<string, unknown>>
}

export interface Runtime {
  readonly sessions: Readable<SessionsSnapshot>
  readonly workspaces: Readable<WorkspacesSnapshot>
  readonly status: Readable<StatusSnapshot>
  readonly backend: Readable<BackendState>
  readonly prefs: Store<Prefs>
  readonly locale: Readable<unknown>
  /** The open context menu's target (row highlight while its menu is up). */
  readonly menuTarget: Readable<MenuTarget | null>
  readonly t: (key: Key, params?: Record<string, unknown>) => string
  readonly searchLimit: number
  open(sessionId: string): void
  startSession(workspaceId?: string): void
  unarchive(sessionId: string): void
  pin(sessionId: string): void
  unpin(sessionId: string): void
  /** Open the native session menu at a point. */
  openSessionMenu(sessionId: string, displayTitle: string, point: { x: number; y: number }): void
  /** The row "…" button: open the session menu, or close it when it is already open for this session. */
  toggleSessionMenu(sessionId: string, displayTitle: string, point: { x: number; y: number }): void
  command(sessionId: string, action: CommandAction): Promise<CommandOutcome>
  setPolicy(draft: PolicyDraft): Promise<PolicyOutcome>
  listTransitions(limit: number): Promise<readonly Transition[]>
  /** Host evaluation of the stored policy (null) or a draft; null without the Host. */
  previewPolicy(draft: PolicyDraft | null): Promise<PolicyPreview | null>
  search(query: string, signal: AbortSignal): Promise<SearchPage>
  createWorkspace(path: string): Promise<void>
  renameWorkspace(workspaceId: string, title: string): Promise<void>
  deleteWorkspace(workspaceId: string): Promise<void>
  /** Host-native directory chooser; null when cancelled or unavailable. */
  pickDirectory(): Promise<string | null>
  /** Opener for this plugin's page under Plugins, or undefined while that page is not served. */
  settingsAction(): (() => void) | undefined
  /** Show a transient notice. */
  notify(text: string): void
  /** Snooze-with-custom-time requests raised from the context menu. */
  readonly snoozeRequest: Store<string | null>
  readonly notice: Store<{ readonly text: string; readonly seq: number } | null>
  /** Whether this plugin's registration renders `sidebar.workspaces` (S01 diagnostics). */
  readonly slotStatus: Readable<SlotStatus>
  /** ⌘K / ⌘O requests raised by the native workspace commands. */
  readonly shortcutRequests: Readable<ShortcutRequests>
  /** Clear the native add-workspace request once handled. */
  closeAddRequest(): void
}
