import { describe, expect, it } from 'vitest'
import { foldQuery, foldText, latestMatch, MAX_DOC_CHARS, projectEvent, snippetAround, type HistoryEvent } from '../../src/domain/history-text.ts'

const user = (text: string, seq = 1, extra: Record<string, unknown> = {}): HistoryEvent => ({
  type: 'user/message', seq, time: 1000 + seq, surfaceOp: 'append',
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }], ...extra },
})
const assistant = (content: unknown[], seq = 2, extra: Record<string, unknown> = {}): HistoryEvent => ({
  type: 'assistant/message', seq, time: 1000 + seq, surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { role: 'assistant', content }, stream: [], ...extra },
})

describe('foldText', () => {
  it('folds case, full-width ASCII and whitespace without moving positions', () => {
    for (const text of ['Hello World', 'ＡＢＣ　ｄｅｆ', 'İstanbul Straße', 'line\none\ttab', '中文搜索 😀 ÉTÉ', 'a\u{1F468}‍\u{1F469}b']) {
      expect(foldText(text)).toHaveLength(text.length)
    }
    expect(foldText('Hello\nWORLD')).toBe('hello world')
    expect(foldText('ＡＢＣ　ｄｅｆ')).toBe('abc def')
    // A character whose lowercase is longer stays as it is.
    expect(foldText('İx')).toBe('İx')
    // Accents and CJK are kept.
    expect(foldText('Été 中文')).toBe('été 中文')
  })

  it('returns the same string when nothing changes', () => {
    const text = 'already folded 中文'
    expect(foldText(text)).toBe(text)
  })

  it('trims and folds queries', () => {
    expect(foldQuery('  Ｆｏｏ\0 ')).toBe('foo')
    expect(foldQuery('   ')).toBe('')
  })
})

describe('projectEvent', () => {
  it('keeps the text a person saw: direct prompts and committed replies, one document per text block', () => {
    expect(projectEvent(user('find the bug'))).toMatchObject([{ role: 'user', text: 'find the bug', folded: 'find the bug', seq: 1, at: 1001 }])
    const docs = projectEvent(assistant([{ type: 'text', text: 'First part' }, { type: 'text', text: 'Second part' }]))
    expect(docs.map(doc => [doc.role, doc.text])).toEqual([['assistant', 'First part'], ['assistant', 'Second part']])
  })

  it('fails closed on everything else', () => {
    // Injected context (file notices, skills, cron) is a user message with another source.
    expect(projectEvent(user('SECRET', 1, { source: { kind: 'file-change' } }))).toEqual([])
    expect(projectEvent(user('SECRET', 1, { source: undefined }))).toEqual([])
    // Interrupted prefixes, reasoning and tool calls.
    expect(projectEvent(assistant([{ type: 'text', text: 'SECRET' }], 2, { interrupted: true }))).toEqual([])
    expect(projectEvent(assistant([
      { type: 'reasoning', text: 'SECRET' }, { type: 'tool-call', name: 'bash', arguments: '{"cmd":"SECRET"}' }, { type: 'image' },
    ]))).toEqual([])
    // Compaction replacement copies are model-only.
    expect(projectEvent({ ...user('SECRET summary'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 4 } })).toEqual([])
    for (const type of ['tool/call', 'tool/result', 'system/message', 'developer/message', 'todo/write', 'turn/end', 'assistant/attempt']) {
      expect(projectEvent({ type, seq: 3, time: 3, data: { content: [{ type: 'text', text: 'SECRET' }], message: { content: [{ type: 'text', text: 'SECRET' }] } } })).toEqual([])
    }
    expect(projectEvent(user('   '))).toEqual([])
  })

  it('accepts messages from logs without a surface marker', () => {
    expect(projectEvent({ ...user('old log'), surfaceOp: undefined })).toHaveLength(1)
  })

  it('bounds very long blocks without splitting a surrogate pair', () => {
    const text = `${'a'.repeat(MAX_DOC_CHARS - 1)}😀tail`
    const [doc] = projectEvent(user(text))
    expect(doc!.text).toHaveLength(MAX_DOC_CHARS - 1)
  })
})

describe('latestMatch and snippetAround', () => {
  const docs = [user('alpha 中文 one', 1), user('beta two', 2), user('Alpha three', 3)].flatMap(projectEvent)

  it('finds the newest document containing the literal folded query', () => {
    expect(latestMatch(docs, 'alpha')?.doc.seq).toBe(3)
    expect(latestMatch(docs, '中')?.doc.seq).toBe(1)
    // A match never spans two messages.
    expect(latestMatch(docs, 'one beta')).toBeNull()
    expect(latestMatch(docs, '')).toBeNull()
    // Literal: no query syntax, no wildcards.
    expect(latestMatch(projectEvent(user('100% done_ok "x"')), '% done_')).not.toBeNull()
    expect(latestMatch(docs, 'alpha OR beta')).toBeNull()
  })

  it('marks the match in a one-line excerpt', () => {
    const text = `${'word '.repeat(40)}The NEEDLE\nis here${' tail'.repeat(60)}`
    const index = foldText(text).indexOf('needle')
    const snippet = snippetAround(text, index, 6)
    expect(snippet.text.slice(...snippet.highlight)).toBe('NEEDLE')
    expect(snippet.text.startsWith('…')).toBe(true)
    expect(snippet.text.endsWith('…')).toBe(true)
    expect(snippet.text).not.toContain('\n')
    expect(snippet.text.length).toBeLessThan(200)
  })

  it('keeps the whole text when short and never splits surrogate pairs', () => {
    expect(snippetAround('find me', 5, 2)).toEqual({ text: 'find me', highlight: [5, 7] })
    const text = `${'😀'.repeat(30)}x`
    const snippet = snippetAround(text, text.length - 1, 1)
    expect(snippet.text.slice(...snippet.highlight)).toBe('x')
    expect(snippet.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})
