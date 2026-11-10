// Scripted Anthropic-Messages-compatible endpoint for local Harness testing.
// No real model, no network. Point Harness at it with:
//   DEEPSEEK_BASE_URL=http://127.0.0.1:<port>  DEEPSEEK_API_KEY=sk-test
// The last human message selects the script:
//   contains "#slow" → streams text for ~SLOW_MS (keeps the turn running)
//   contains "#fail" → HTTP 400 (the turn ends with an error)
//   contains "#bash" → requests one bash tool call (approval under "ask"), then answers
//   otherwise        → a short reply that ends the turn
// Markers are explicit because Harness appends runtime context to user turns.
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 47900)
const SLOW_MS = Number(process.env.MOCK_SLOW_MS ?? 20000)

const lastUserText = (body) => {
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const message = body.messages[i]
    if (message.role !== 'user') continue
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    const text = parts.filter(part => part.type === 'text').map(part => part.text).join(' ')
    const toolResult = parts.some(part => part.type === 'tool_result')
    return { text, toolResult }
  }
  return { text: '', toolResult: false }
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function streamText(res, model, text, delayMs) {
  sse(res, 'message_start', { message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  const words = text.split(' ')
  for (const word of words) {
    sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: `${word} ` } })
    if (delayMs > 0) await sleep(delayMs)
  }
  sse(res, 'content_block_stop', { index: 0 })
  sse(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: words.length } })
  sse(res, 'message_stop', {})
  res.end()
}

function streamToolUse(res, model) {
  sse(res, 'message_start', { message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  sse(res, 'content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: 'bash', input: {} } })
  sse(res, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo sidebar-fixture > fixture.txt', description: 'write a fixture file' }) } })
  sse(res, 'content_block_stop', { index: 0 })
  sse(res, 'message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
  sse(res, 'message_stop', {})
  res.end()
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', async () => {
    if (!req.url?.endsWith('/messages')) {
      res.writeHead(404).end()
      return
    }
    let body
    try { body = JSON.parse(raw) } catch { res.writeHead(400).end(); return }
    const { text: rawText, toolResult } = lastUserText(body)
    const text = /Generate the session title/.test(rawText) ? '' : rawText
    const model = body.model ?? 'deepseek-flash'
    process.stderr.write(`[mock-llm] ${new Date().toISOString()} model=${model} text=${JSON.stringify(text.slice(0, 60))} toolResult=${toolResult}\n`)
    if (/#fail\b/.test(text) && !toolResult) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'scripted failure' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    if (/#bash\b/.test(text) && !toolResult) { streamToolUse(res, model); return }
    if (/#slow\b/.test(text) && !toolResult) {
      const words = Array.from({ length: 40 }, (_, i) => `step${i}`).join(' ')
      await streamText(res, model, words, SLOW_MS / 40)
      return
    }
    await streamText(res, model, toolResult ? 'Done with the tool.' : 'Fixture reply. Done.', 5)
  })
})

server.listen(port, '127.0.0.1', () => process.stderr.write(`[mock-llm] listening on ${port}\n`))
