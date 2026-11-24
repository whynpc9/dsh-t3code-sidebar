/**
 * History search text rules, shared by the Host index and its tests.
 *
 * - Projection: only the conversation a person saw — text blocks of direct
 *   user prompts (`source.kind === 'user'`) and of committed, uninterrupted
 *   assistant messages, each block a separate document. Reasoning, tool calls
 *   and results, injected context, compaction replacements and unknown blocks
 *   contribute nothing (fail closed).
 * - Matching: a query is one literal substring of one document, compared after
 *   `foldText` (case, full-width ASCII, whitespace, traditional → simplified
 *   Chinese characters). No query syntax.
 * - Folding keeps UTF-16 positions, so a match in folded text is the same range
 *   of the original text.
 */
import { SIMPLIFIED, TRADITIONAL } from './chinese-variants.ts'

export type HistoryRole = 'user' | 'assistant'

export interface HistoryDoc {
  readonly seq: number
  readonly at: number
  readonly role: HistoryRole
  readonly text: string
  /** `foldText(text)`; the same string when folding changes nothing. */
  readonly folded: string
}

/** A stored session event, reduced to what projection reads. */
export interface HistoryEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: unknown
}

/**
 * Safety bound per document (a pasted log, not a message anyone wrote); the
 * rest of such a block is not searchable.
 */
export const MAX_DOC_CHARS = 4 * 1024 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ASCII = /^[\x00-\x7F]*$/
const ASCII_SPACE = /[\t\n\v\f\r\0]/g

let variants: Map<string, string> | undefined
/** Traditional → simplified, one BMP character each (built on first use). */
function simplified(char: string): string {
  if (variants === undefined) {
    variants = new Map()
    for (let i = 0; i < TRADITIONAL.length; i++) variants.set(TRADITIONAL[i] as string, SIMPLIFIED[i] as string)
  }
  return variants.get(char) ?? char
}

/**
 * Case-, width- and script-insensitive form of `text` with the same UTF-16
 * length and positions: lowercase (locale independent) where that keeps a
 * character's length, full-width ASCII and the ideographic space to ASCII,
 * every whitespace character (and NUL) to a space, traditional Chinese
 * characters to simplified (OpenCC character table, first candidate). No
 * NFKC, no accent stripping, no phrase-level conversion.
 */
export function foldText(text: string): string {
  if (ASCII.test(text)) {
    const folded = text.toLowerCase().replace(ASCII_SPACE, ' ')
    return folded === text ? text : folded
  }
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) as number
    if (code >= 0xFF01 && code <= 0xFF5E) {
      out += String.fromCharCode(code - 0xFEE0).toLowerCase()
    } else if (code === 0 || /\s/.test(char)) {
      out += char.length === 1 ? ' ' : char
    } else {
      const variant = code >= 0x3400 ? simplified(char) : char
      if (variant !== char) {
        out += variant
      } else {
        const lower = char.toLowerCase()
        out += lower.length === char.length ? lower : char
      }
    }
  }
  return out === text ? text : out
}

/** A query in folded form: NUL removed, trimmed, folded; empty means "no query". */
export function foldQuery(query: string): string {
  return foldText(query.replaceAll('\0', '').trim())
}

/** Cut at most `max` UTF-16 units without splitting a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xD800 && last <= 0xDBFF) end--
  return text.slice(0, end)
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') continue
    const text = clip(block['text'], MAX_DOC_CHARS)
    if (text.trim() !== '') texts.push(text)
  }
  return texts
}

/**
 * Searchable documents of one event: the text blocks a person saw in the chat,
 * or none.
 */
export function projectEvent(event: HistoryEvent): HistoryDoc[] {
  // Replacement copies (compaction) are model-only; the transcript keeps the originals.
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return []
  const data = event.data
  if (!isRecord(data)) return []
  let role: HistoryRole
  let content: unknown
  if (event.type === 'user/message') {
    const source = data['source']
    if (!isRecord(source) || source['kind'] !== 'user') return []
    role = 'user'
    content = data['content']
  } else if (event.type === 'assistant/message') {
    if (data['interrupted'] === true) return []
    const message = data['message']
    if (!isRecord(message)) return []
    role = 'assistant'
    content = message['content']
  } else {
    return []
  }
  return textBlocks(content).map(text => ({ seq: event.seq, at: event.time, role, text, folded: foldText(text) }))
}

export interface Snippet {
  readonly text: string
  /** UTF-16 half-open range of the match inside `text`. */
  readonly highlight: readonly [number, number]
}

const SNIPPET_BEFORE = 24
const SNIPPET_TOTAL = 160

const collapse = (text: string): string => text.replace(/\s+/g, ' ')
const isLow = (code: number): boolean => code >= 0xDC00 && code <= 0xDFFF

/**
 * A one-line excerpt around a match: a short lead-in so the match stays
 * visible in a narrow row, whitespace collapsed, ellipses where cut.
 */
export function snippetAround(text: string, index: number, length: number): Snippet {
  let start = Math.max(0, index - SNIPPET_BEFORE)
  if (start > 0 && isLow(text.charCodeAt(start))) start--
  let end = Math.min(text.length, index + length + Math.max(0, SNIPPET_TOTAL - SNIPPET_BEFORE - length))
  if (end < text.length && isLow(text.charCodeAt(end))) end++
  let before = collapse(text.slice(start, index))
  const match = collapse(text.slice(index, index + length))
  let after = collapse(text.slice(index + length, end))
  if (start === 0) before = before.trimStart()
  else before = `…${before.trimStart()}`
  if (end === text.length) after = after.trimEnd()
  else after = `${after.trimEnd()}…`
  return { text: before + match + after, highlight: [before.length, before.length + match.length] }
}

export interface TextMatch {
  readonly seq: number
  readonly at: number
  readonly role: HistoryRole
  /** The matching document's original text. */
  readonly text: string
  /** Match position inside `text`. */
  readonly index: number
}

const SEPARATOR = '\0'

/**
 * One session's documents packed for memory and scan speed: the texts joined
 * into one string (NUL-separated; folded text and queries never contain NUL,
 * so a match cannot span two documents), with per-document offsets, seqs,
 * times and roles in flat arrays. The folded copy exists only once some
 * document folds differently.
 */
export class SessionText {
  private text = ''
  private folded: string | null = null
  private readonly starts: number[] = []
  private readonly seqs: number[] = []
  private readonly ats: number[] = []
  private roles = ''

  get documents(): number { return this.starts.length }
  /** UTF-16 units held, both copies included. */
  get units(): number { return this.text.length + (this.folded?.length ?? 0) }

  add(doc: HistoryDoc): void {
    const lead = this.starts.length === 0 ? '' : SEPARATOR
    const start = this.text.length + lead.length
    if (this.folded === null && doc.folded !== doc.text) this.folded = this.text
    if (this.folded !== null) this.folded += lead + doc.folded
    this.text += lead + doc.text
    this.starts.push(start)
    this.seqs.push(doc.seq)
    this.ats.push(doc.at)
    this.roles += doc.role === 'user' ? 'u' : 'a'
  }

  /**
   * Keep only the newest documents that fit in `maxUnits` (both copies and
   * separators counted). Returns whether any document was dropped.
   */
  keepNewest(maxUnits: number): boolean {
    if (this.units <= maxUnits) return false
    const count = this.starts.length
    const copies = this.folded === null ? 1 : 2
    let used = 0
    let first = count
    while (first > 0) {
      const index = first - 1
      const end = index + 1 < count ? (this.starts[index + 1] as number) - SEPARATOR.length : this.text.length
      const cost = (end - (this.starts[index] as number) + SEPARATOR.length) * copies
      if (used + cost > maxUnits) break
      used += cost
      first = index
    }
    const kept: HistoryDoc[] = []
    for (let index = first; index < count; index++) {
      const start = this.starts[index] as number
      const end = index + 1 < count ? (this.starts[index + 1] as number) - SEPARATOR.length : this.text.length
      const text = this.text.slice(start, end)
      kept.push({
        seq: this.seqs[index] as number, at: this.ats[index] as number, role: this.roles[index] === 'u' ? 'user' : 'assistant',
        text, folded: this.folded === null ? text : this.folded.slice(start, end),
      })
    }
    this.text = ''
    this.folded = null
    this.starts.length = 0
    this.seqs.length = 0
    this.ats.length = 0
    this.roles = ''
    for (const doc of kept) this.add(doc)
    return true
  }

  /** The newest document containing `foldedQuery`, or null. */
  latest(foldedQuery: string): TextMatch | null {
    if (foldedQuery === '' || foldedQuery.includes(SEPARATOR)) return null
    const position = (this.folded ?? this.text).lastIndexOf(foldedQuery)
    if (position < 0) return null
    let low = 0
    let high = this.starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((this.starts[mid] as number) <= position) low = mid
      else high = mid - 1
    }
    const start = this.starts[low] as number
    const end = low + 1 < this.starts.length ? (this.starts[low + 1] as number) - SEPARATOR.length : this.text.length
    return {
      seq: this.seqs[low] as number,
      at: this.ats[low] as number,
      role: this.roles[low] === 'u' ? 'user' : 'assistant',
      text: this.text.slice(start, end),
      index: position - start,
    }
  }
}
