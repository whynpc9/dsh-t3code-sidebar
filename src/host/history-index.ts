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
 *   only the events after the last one indexed, starting one event early: if
 *   that event is not the one indexed last (a rewritten or shorter log), the
 *   whole log is read again. A periodic full read covers rewrites further back.
 * - Bounded: the text held never exceeds `maxUnits`. Sessions are read newest
 *   first; past the budget the oldest-created sessions give way (a session
 *   created later, or growing live, evicts them), and a single session larger
 *   than the budget keeps only its newest messages. Results then say `limited`.
 * - Exact: a search scans every indexed document (no candidate window), so
 *   short and CJK queries and the oldest history are found once indexed.
 * - Honest: while sessions are still being read, or a read failed, results
 *   carry `complete: false` and the progress so the Client never presents a
 *   partial scan as "no matches"; `reading` says whether asking again can help.
 */
import { foldQuery, projectEvent, SessionText, snippetAround, type HistoryEvent, type HistoryRole } from '../domain/history-text.ts'

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
  /** Older sessions or messages were left out to stay within the memory budget. */
  readonly limited: boolean
  /** Sessions are still to be listed or read: asking again can find more. */
  readonly reading: boolean
  /** Sessions read so far / listed; null once complete. */
  readonly progress: { readonly indexed: number; readonly total: number } | null
}

export interface HistoryStats {
  readonly sessions: number
  readonly documents: number
  /** UTF-16 units of text held (both the original and the folded copy). */
  readonly units: number
}

/** The sessions could not be listed and nothing is indexed: the caller should fall back. */
export class HistoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super('session history could not be listed', { cause })
    this.name = 'HistoryUnavailableError'
  }
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
  /**
   * How long a search waits for a routine re-listing once every session is
   * indexed (listing thousands of sessions takes the Harness close to a
   * second; live events already cover new messages meanwhile).
   */
  readonly refreshWaitMs?: number
  readonly concurrency?: number
  /** Text budget in UTF-16 units (original + folded copies); about 1.4 bytes of heap each. */
  readonly maxUnits?: number
  readonly readTimeoutMs?: number
  readonly now?: () => number
}

interface Entry {
  /** Header creation time; the budget gives way oldest first. */
  createdAt: number
  token: string | undefined
  /** Events consumed from the log (the next read offset). */
  offset: number
  lastSeq: number
  /** Identity of the last event consumed (`seq|type|time`), checked by the next incremental read. */
  lastKey: string
  fullAt: number
  body: SessionText
  /** Read at least once; live events alone do not make an entry indexed. */
  indexed: boolean
  failed: boolean
  /** Not held: the budget was spent on newer sessions. */
  limited: boolean
  /** Held, but only its newest messages (larger than the budget alone). */
  trimmed: boolean
  /** Indexed, but the log changed and the read that catches up has not finished. */
  stale: boolean
  /** Live events observed while a read of this log is in flight, replayed after it commits. */
  inflight: HistoryEvent[] | undefined
}

const eventKey = (event: HistoryEvent): string => `${event.seq}|${event.type}|${event.time}`
const emptyEntry = (createdAt: number): Entry => ({
  createdAt, token: undefined, offset: 0, lastSeq: -1, lastKey: '', fullAt: 0, body: new SessionText(),
  indexed: false, failed: false, limited: false, trimmed: false, stale: false, inflight: undefined,
})
/** Live events kept per read in flight; past this the next refresh catches up from the log. */
const MAX_INFLIGHT_EVENTS = 1_000
/** Whether `left` gives way before `right` (older first; id breaks ties). */
const yieldsTo = (left: [string, Entry], right: [string, Entry]): boolean =>
  left[1].createdAt < right[1].createdAt || (left[1].createdAt === right[1].createdAt && left[0] < right[0])

/** Default budget: about 180 MB of heap, roughly 250,000 messages of a few hundred characters (measured). */
export const DEFAULT_MAX_UNITS = 128 * 1024 * 1024

const yieldToLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const SCAN_SLICE = 200

export class HistoryIndex {
  private entries = new Map<string, Entry>()
  private listed = false
  private listedAt = 0
  private listing: Promise<void> | undefined
  /** A session was first seen live since the last listing started: list again on the next search. */
  private relistDue = false
  /** Why the last listing failed, while nothing has been listed yet. */
  private listError: unknown
  private controller = new AbortController()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private readonly refreshMs: number
  private readonly fullReadMs: number
  private readonly idleMs: number
  private readonly waitMs: number
  private readonly refreshWaitMs: number
  private readonly concurrency: number
  private readonly maxUnits: number
  /** Units held by all entries (kept in step with every change). */
  private units = 0
  private readonly readTimeoutMs: number
  private readonly now: () => number

  constructor(private readonly source: HistorySource, options: HistoryIndexOptions = {}) {
    this.refreshMs = options.refreshMs ?? 15_000
    this.fullReadMs = options.fullReadMs ?? 10 * 60_000
    this.idleMs = options.idleMs ?? 30 * 60_000
    this.waitMs = options.waitMs ?? 1_500
    this.refreshWaitMs = options.refreshWaitMs ?? 150
    this.concurrency = options.concurrency ?? 2
    this.maxUnits = options.maxUnits ?? DEFAULT_MAX_UNITS
    this.readTimeoutMs = options.readTimeoutMs ?? 10_000
    this.now = options.now ?? Date.now
  }

  /** Whether the index currently holds data (tests and diagnostics). */
  get active(): boolean { return this.listed || this.listing !== undefined }

  stats(): HistoryStats {
    let documents = 0
    let units = 0
    for (const entry of this.entries.values()) {
      documents += entry.body.documents
      units += entry.body.units
    }
    return { sessions: this.entries.size, documents, units }
  }

  async search(query: string, limit: number, signal: AbortSignal): Promise<HistoryResult> {
    if (this.disposed) throw new Error('history index disposed')
    this.touch()
    const folded = foldQuery(query)
    const ready = this.ready()
    const sync = this.refresh()
    if (sync !== undefined) await waitAtMost(sync, ready ? this.refreshWaitMs : this.waitMs, signal)
    signal.throwIfAborted()
    if (!this.listed && this.listing === undefined && this.listError !== undefined) {
      // The first listing failed: say so (the next search lists again) rather than "still reading".
      const error = this.listError
      this.listError = undefined
      throw new HistoryUnavailableError(error)
    }
    // Completeness is taken before the scan: a read that commits while the scan yields may land
    // in an entry already scanned, so only the state as of the start is known to be covered.
    const total = this.entries.size
    let indexed = 0
    let pending = 0
    let failed = false
    let limited = false
    for (const entry of this.entries.values()) {
      // A changed log whose catch-up read is still running is not up to date yet.
      if (entry.indexed && !entry.stale) indexed++
      else if (entry.stale || (!entry.failed && !entry.limited)) pending++
      if (entry.failed) failed = true
      if (entry.limited || entry.trimmed) limited = true
    }
    const listed = this.listed
    const hits: HistoryHit[] = []
    let scanned = 0
    for (const [sessionId, entry] of this.entries) {
      if (++scanned % SCAN_SLICE === 0) {
        await yieldToLoop()
        signal.throwIfAborted()
      }
      const match = entry.body.latest(folded)
      if (match === null) continue
      const snippet = snippetAround(match.text, match.index, folded.length)
      hits.push({ sessionId, seq: match.seq, at: match.at, role: match.role, snippet: snippet.text, highlight: snippet.highlight })
    }
    hits.sort((left, right) => right.at - left.at || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0))
    // A routine re-listing in flight does not make a fully indexed result partial.
    const complete = listed && indexed === total && !failed && !limited
    return {
      hits: hits.slice(0, limit),
      hasMore: hits.length > limit,
      complete,
      limited,
      reading: !listed || pending > 0,
      progress: complete ? null : { indexed, total },
    }
  }

  /** Listed, and every listed session read (or left out by the budget). */
  private ready(): boolean {
    if (!this.listed) return false
    for (const entry of this.entries.values()) if (!entry.indexed && !entry.limited) return false
    return true
  }

  /** A committed event of a live session: index new messages of sessions already read. */
  observe(sessionId: string, event: HistoryEvent): void {
    if (this.disposed || !this.listed) return
    const entry = this.entries.get(sessionId)
    if (entry === undefined) {
      // A new session (the newest): track it, and list again on the next search to read it in full.
      this.entries.set(sessionId, emptyEntry(this.now()))
      this.relistDue = true
      return
    }
    // A read in flight may have missed this event: keep it to replay once the read commits.
    if (entry.inflight !== undefined && entry.inflight.length < MAX_INFLIGHT_EVENTS) entry.inflight.push(event)
    if (!entry.indexed || event.seq !== entry.lastSeq + 1) return
    const before = entry.body.units
    for (const doc of projectEvent(event)) entry.body.add(doc)
    this.units += entry.body.units - before
    this.enforceBudget(sessionId, entry)
    entry.lastSeq = event.seq
    entry.lastKey = eventKey(event)
    entry.offset += 1
  }

  /** Drop everything (option switched off, idle, or service disposal keeps it closed). */
  clear(): void {
    this.controller.abort()
    this.controller = new AbortController()
    this.entries = new Map()
    this.units = 0
    this.listed = false
    this.listedAt = 0
    this.listing = undefined
    this.listError = undefined
    this.relistDue = false
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
    if (this.listed && !this.relistDue && this.now() - this.listedAt < this.refreshMs) return undefined
    const signal = this.controller.signal
    const pass = this.sync(signal).catch((error: unknown) => {
      if (!signal.aborted && !this.listed) this.listError = error
    }).finally(() => {
      if (this.listing === pass) this.listing = undefined
    })
    this.listing = pass
    return pass
  }

  private async sync(signal: AbortSignal): Promise<void> {
    // Sessions first seen live during the listing are newer than its snapshot: keep them.
    const known = new Set(this.entries.keys())
    this.relistDue = false
    const listing = await this.source.list(signal)
    if (signal.aborted) return
    this.listError = undefined
    const now = this.now()
    const present = new Set(listing.map(item => item.id))
    // Absent from a successful listing: deleted (or no longer stored); drop its text.
    for (const [id, entry] of [...this.entries]) {
      if (present.has(id) || !known.has(id)) continue
      this.entries.delete(id)
      this.units -= entry.body.units
    }
    const due: { id: string; token: string | undefined; full: boolean }[] = []
    for (const item of [...listing].sort((left, right) => right.createdAt - left.createdAt)) {
      let entry = this.entries.get(item.id)
      if (entry === undefined) {
        entry = emptyEntry(item.createdAt)
        this.entries.set(item.id, entry)
      }
      entry.createdAt = item.createdAt
      const full = !entry.indexed || now - entry.fullAt >= this.fullReadMs
      const changed = item.token !== undefined && item.token !== entry.token
      // Known to have changed: results stay incomplete until the read catches up.
      if (entry.indexed && changed) entry.stale = true
      if (full || entry.failed || changed || item.token === undefined) due.push({ id: item.id, token: item.token, full })
    }
    this.listed = true
    this.listedAt = now
    let next = 0
    // Set once a session had to be cut for the budget: every later (older) one would be too.
    let budgetSpent = false
    const worker = async (): Promise<void> => {
      while (next < due.length && !signal.aborted) {
        const job = due[next++] as (typeof due)[number]
        const entry = this.entries.get(job.id)
        // Over budget: read a session only when an older one can give way to it.
        if (entry !== undefined && !entry.indexed && (budgetSpent || this.units >= this.maxUnits)
          && this.oldestHolder([job.id, entry]) === undefined) {
          entry.limited = true
          continue
        }
        if (await this.readOne(job.id, job.token, job.full, signal)) budgetSpent = true
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, worker))
  }

  /** Read one log into the index; true when the budget made it cut this session itself. */
  private async readOne(id: string, token: string | undefined, full: boolean, signal: AbortSignal): Promise<boolean> {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    // An incremental read starts at the last event consumed, to confirm the log still continues it.
    const overlap = !full && entry.offset > 0
    const offset = full ? 0 : overlap ? entry.offset - 1 : entry.offset
    const expectedKey = entry.lastKey
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(this.readTimeoutMs)])
    let events: readonly HistoryEvent[] | null
    entry.inflight = []
    try {
      events = await this.source.read(id, offset, readSignal)
    } catch {
      events = null
    }
    const live = entry.inflight
    entry.inflight = undefined
    // Aborted, deleted or evicted meanwhile (evicting replaces the entry): commit nothing.
    if (signal.aborted || this.entries.get(id) !== entry) return false
    if (events === null) {
      entry.failed = true
      entry.stale = false
      return false
    }
    if (overlap) {
      const first = events[0]
      if (first === undefined || eventKey(first) !== expectedKey) return await this.readOne(id, token, true, signal)
      events = events.slice(1)
    }
    const before = entry.body.units
    if (full) {
      const body = new SessionText()
      for (const event of events) for (const doc of projectEvent(event)) body.add(doc)
      entry.body = body
      entry.offset = events.length
      entry.fullAt = this.now()
      entry.lastSeq = -1
      entry.lastKey = ''
      const last = events.at(-1)
      if (last !== undefined) {
        entry.lastSeq = last.seq
        entry.lastKey = eventKey(last)
      }
      // Live events committed after the read's snapshot: the new body must keep them.
      for (const event of live) {
        if (event.seq !== entry.lastSeq + 1) continue
        for (const doc of projectEvent(event)) body.add(doc)
        entry.lastSeq = event.seq
        entry.lastKey = eventKey(event)
        entry.offset += 1
      }
    } else {
      // Live events observed meanwhile are already indexed: add only what is new.
      for (const event of events) {
        if (event.seq <= entry.lastSeq) continue
        for (const doc of projectEvent(event)) entry.body.add(doc)
      }
      entry.offset = offset + (overlap ? 1 : 0) + events.length
    }
    const last = events.at(-1)
    if (last !== undefined && last.seq > entry.lastSeq) {
      entry.lastSeq = last.seq
      entry.lastKey = eventKey(last)
    }
    this.units += entry.body.units - before
    entry.token = token
    entry.indexed = true
    entry.failed = false
    entry.limited = false
    entry.stale = false
    if (full) entry.trimmed = false
    return this.enforceBudget(id, entry)
  }

  /** The oldest session holding text that yields to `than`, if any. */
  private oldestHolder(than: [string, Entry]): [string, Entry] | undefined {
    let oldest: [string, Entry] | undefined
    for (const candidate of this.entries) {
      if (candidate[1] === than[1] || candidate[1].body.units === 0 || !yieldsTo(candidate, than)) continue
      if (oldest === undefined || yieldsTo(candidate, oldest)) oldest = candidate
    }
    return oldest
  }

  /**
   * After `id` grew: evict older sessions, then trim `id` itself, until within
   * the budget. Returns true when `id` itself had to be cut.
   */
  private enforceBudget(id: string, entry: Entry): boolean {
    while (this.units > this.maxUnits) {
      const victim = this.oldestHolder([id, entry])
      if (victim !== undefined) {
        this.evict(victim[0], victim[1])
        continue
      }
      // Every other holder is newer: this session keeps only its newest messages that still fit.
      this.units -= entry.body.units
      entry.body.keepNewest(Math.max(0, this.maxUnits - this.units))
      this.units += entry.body.units
      if (entry.body.documents === 0) this.evict(id, entry)
      else entry.trimmed = true
      return true
    }
    return false
  }

  /**
   * Drop a session's text. The entry is replaced, not emptied in place, so a
   * read of it still in flight sees the change and discards what it read.
   */
  private evict(id: string, entry: Entry): void {
    this.units -= entry.body.units
    this.entries.set(id, { ...emptyEntry(entry.createdAt), limited: true })
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
