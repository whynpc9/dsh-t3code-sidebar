/**
 * History search text rules, shared by the Host index and its tests.
 *
 * - Projection: only the conversation a person saw — text blocks of direct
 *   user prompts (`source.kind === 'user'`) and of committed, uninterrupted
 *   assistant messages, each block a separate document. Reasoning, tool calls
 *   and results, injected context, compaction replacements and unknown blocks
 *   contribute nothing (fail closed).
 * - Matching: a query is one literal substring of one document, compared after
 *   `foldText` (case, full-width ASCII, whitespace). No query syntax.
 * - Folding keeps UTF-16 positions, so a match in folded text is the same range
 *   of the original text.
 */

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

/** Text kept per document; the rest of a very long block is not searchable. */
export const MAX_DOC_CHARS = 64 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ASCII = /^[\x00-\x7F]*$/
const ASCII_SPACE = /[\t\n\v\f\r]/g

/**
 * Case- and width-insensitive form of `text` with the same UTF-16 length and
 * positions: lowercase (locale independent) where that keeps a character's
 * length, full-width ASCII and the ideographic space to ASCII, every
 * whitespace character to a space. No NFKC, no accent stripping.
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
    } else if (/\s/.test(char)) {
      out += char.length === 1 ? ' ' : char
    } else {
      const lower = char.toLowerCase()
      out += lower.length === char.length ? lower : char
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

export interface DocMatch {
  readonly doc: HistoryDoc
  readonly index: number
}

/** The newest document containing `foldedQuery` (documents in log order), or null. */
export function latestMatch(docs: readonly HistoryDoc[], foldedQuery: string): DocMatch | null {
  if (foldedQuery === '') return null
  for (let i = docs.length - 1; i >= 0; i--) {
    const doc = docs[i] as HistoryDoc
    const index = doc.folded.indexOf(foldedQuery)
    if (index >= 0) return { doc, index }
  }
  return null
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
