/**
 * Opt-in history search: an in-memory index of the conversation text of every
 * stored session, owned by the Host service.
 *
 * - Lazy: nothing is listed or read until the first search, and the index is
 *   dropped after `idleMs` without one, so a Client with the option off costs
 *   nothing.
 * - Source: `sessionPersistence.list()` and `read` handles (never attaches,
 *   resumes or starts a session); live `session/event`s append new messages
 *   to sessions already indexed.
 * - Incremental: the log is append-only, so a changed persistence token reads
 *   only the events after the last one indexed; a periodic full read covers
 *   anything an incremental read cannot vouch for.
 * - Exact: a search scans every indexed document (no candidate window), so
 *   short and CJK queries and the oldest history are found once indexed.
 * - Honest: while sessions are still being read, or a read failed, results
 *   carry `complete: false` and the progress so the Client never presents a
 *   partial scan as "no matches".
 */
import { foldQuery, latestMatch, projectEvent, snippetAround, type HistoryDoc, type HistoryEvent, type HistoryRole } from '../domain/history-text.ts'

export interface HistorySource {
  /** Every stored, non-subagent session with its change token (undefined: no token). */
  list(signal: AbortSignal): Promise<readonly { readonly id: string; readonly createdAt: number; readonly token: string | undefined }[]>
  /**
   * Events from `offset` to the end of one stored log, or null when it cannot
   * be read. Must release whatever it opened.
   */
  read(id: string, offset: number, signal: AbortSignal): Promise<readonly HistoryEvent[] | null>
}

export interface HistoryHit {
  readonly sessionId: string
  readonly seq: number
  readonly at: number
  readonly role: HistoryRole
  readonly snippet: string
  readonly highlight: readonly [number, number]
}

export interface HistoryResult {
  readonly hits: readonly HistoryHit[]
  readonly hasMore: boolean
  /** Every listed session was read and the listing is current. */
  readonly complete: boolean
  /** Sessions read so far / listed; null once complete. */
  readonly progress: { readonly indexed: number; readonly total: number } | null
}

export interface HistoryIndexOptions {
  /** Re-list sessions at most this often (on search). */
  readonly refreshMs?: number
  /** Re-read a whole log when its last full read is older than this. */
  readonly fullReadMs?: number
  /** Drop the index after this long without a search. */
  readonly idleMs?: number
  /** How long a search waits for indexing in progress before answering partially. */
  readonly waitMs?: number
  readonly concurrency?: number
  readonly readTimeoutMs?: number
  readonly now?: () => number
}

interface Entry {
  token: string | undefined
  /** Events consumed from the log (the next read offset). */
  offset: number
  lastSeq: number
  fullAt: number
  docs: HistoryDoc[]
  /** Read at least once; live events alone do not make an entry indexed. */
  indexed: boolean
  failed: boolean
}

const yieldToLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const SCAN_SLICE = 200

export class HistoryIndex {
  private entries = new Map<string, Entry>()
  private listed = false
  private listedAt = 0
  private listing: Promise<void> | undefined
  private controller = new AbortController()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private readonly refreshMs: number
  private readonly fullReadMs: number
  private readonly idleMs: number
  private readonly waitMs: number
  private readonly concurrency: number
  private readonly readTimeoutMs: number
  private readonly now: () => number

  constructor(private readonly source: HistorySource, options: HistoryIndexOptions = {}) {
    this.refreshMs = options.refreshMs ?? 15_000
    this.fullReadMs = options.fullReadMs ?? 10 * 60_000
    this.idleMs = options.idleMs ?? 30 * 60_000
    this.waitMs = options.waitMs ?? 1_500
    this.concurrency = options.concurrency ?? 2
    this.readTimeoutMs = options.readTimeoutMs ?? 10_000
    this.now = options.now ?? Date.now
  }

  /** Whether the index currently holds data (tests and diagnostics). */
  get active(): boolean { return this.listed || this.listing !== undefined }

  async search(query: string, limit: number, signal: AbortSignal): Promise<HistoryResult> {
    if (this.disposed) throw new Error('history index disposed')
    this.touch()
    const folded = foldQuery(query)
    const sync = this.refresh()
    if (sync !== undefined) await waitAtMost(sync, this.waitMs, signal)
    signal.throwIfAborted()
    const hits: HistoryHit[] = []
    let scanned = 0
    for (const [sessionId, entry] of this.entries) {
      if (++scanned % SCAN_SLICE === 0) {
        await yieldToLoop()
        signal.throwIfAborted()
      }
      const match = latestMatch(entry.docs, folded)
      if (match === null) continue
      const snippet = snippetAround(match.doc.text, match.index, folded.length)
      hits.push({ sessionId, seq: match.doc.seq, at: match.doc.at, role: match.doc.role, snippet: snippet.text, highlight: snippet.highlight })
    }
    hits.sort((left, right) => right.at - left.at || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0))
    const total = this.entries.size
    let indexed = 0
    let failed = false
    for (const entry of this.entries.values()) {
      if (entry.indexed) indexed++
      if (entry.failed) failed = true
    }
    const complete = this.listed && this.listing === undefined && indexed === total && !failed
    return {
      hits: hits.slice(0, limit),
      hasMore: hits.length > limit,
      complete,
      progress: complete ? null : { indexed, total },
    }
  }

  /** A committed event of a live session: index new messages of sessions already read. */
  observe(sessionId: string, event: HistoryEvent): void {
    if (this.disposed || !this.listed) return
    const entry = this.entries.get(sessionId)
    if (entry === undefined) {
      // A new session: list it now so the next refresh reads it in full.
      this.entries.set(sessionId, { token: undefined, offset: 0, lastSeq: -1, fullAt: 0, docs: [], indexed: false, failed: false })
      return
    }
    if (!entry.indexed || event.seq !== entry.lastSeq + 1) return
    entry.docs.push(...projectEvent(event))
    entry.lastSeq = event.seq
    entry.offset += 1
  }

  /** Drop everything (option switched off, idle, or service disposal keeps it closed). */
  clear(): void {
    this.controller.abort()
    this.controller = new AbortController()
    this.entries = new Map()
    this.listed = false
    this.listedAt = 0
    this.listing = undefined
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  dispose(): void {
    this.disposed = true
    this.clear()
  }

  private touch(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { this.clear() }, this.idleMs)
    ;(this.idleTimer as { unref?: () => void }).unref?.()
  }

  /** Start a listing + read pass when due; returns the pass in flight, if any. */
  private refresh(): Promise<void> | undefined {
    if (this.listing !== undefined) return this.listing
    if (this.listed && this.now() - this.listedAt < this.refreshMs) return undefined
    const signal = this.controller.signal
    const pass = this.sync(signal).catch(() => undefined).finally(() => {
      if (this.listing === pass) this.listing = undefined
    })
    this.listing = pass
    return pass
  }

  private async sync(signal: AbortSignal): Promise<void> {
    const listing = await this.source.list(signal)
    if (signal.aborted) return
    const now = this.now()
    const present = new Set(listing.map(item => item.id))
    // Absent from a successful listing: deleted (or no longer stored); drop its text.
    for (const id of [...this.entries.keys()]) if (!present.has(id)) this.entries.delete(id)
    const due: { id: string; token: string | undefined; full: boolean }[] = []
    for (const item of [...listing].sort((left, right) => right.createdAt - left.createdAt)) {
      let entry = this.entries.get(item.id)
      if (entry === undefined) {
        entry = { token: undefined, offset: 0, lastSeq: -1, fullAt: 0, docs: [], indexed: false, failed: false }
        this.entries.set(item.id, entry)
      }
      const full = !entry.indexed || now - entry.fullAt >= this.fullReadMs
      if (full || entry.failed || item.token === undefined || item.token !== entry.token) due.push({ id: item.id, token: item.token, full })
    }
    this.listed = true
    this.listedAt = now
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < due.length && !signal.aborted) {
        const job = due[next++] as (typeof due)[number]
        await this.readOne(job.id, job.token, job.full, signal)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, worker))
  }

  private async readOne(id: string, token: string | undefined, full: boolean, signal: AbortSignal): Promise<void> {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    const offset = full ? 0 : entry.offset
    const expectedSeq = entry.lastSeq + 1
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(this.readTimeoutMs)])
    let events: readonly HistoryEvent[] | null
    try {
      events = await this.source.read(id, offset, readSignal)
    } catch {
      events = null
    }
    if (signal.aborted || this.entries.get(id) !== entry) return
    // An incremental read must continue exactly where the last one stopped.
    if (events !== null && !full && events.length > 0 && events[0]?.seq !== expectedSeq) {
      return await this.readOne(id, token, true, signal)
    }
    if (events === null) {
      entry.failed = true
      return
    }
    const docs = events.flatMap(projectEvent)
    if (full) {
      entry.docs = docs
      entry.offset = events.length
      entry.fullAt = this.now()
    } else {
      // Live events observed meanwhile are already in `docs`: keep only what is new.
      entry.docs.push(...docs.filter(doc => doc.seq > entry.lastSeq))
      entry.offset = offset + events.length
    }
    const last = events.at(-1)
    if (last !== undefined) entry.lastSeq = Math.max(full ? -1 : entry.lastSeq, last.seq)
    entry.token = token
    entry.indexed = true
    entry.failed = false
  }
}

async function waitAtMost(work: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) }),
      new Promise<void>((resolve) => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
