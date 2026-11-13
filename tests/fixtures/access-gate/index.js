// Enter the same authenticated Connection/Gateway APIs used by LiveShare.
// The route itself requires the isolated profile's owner browser cookie.
// The test controls only the fixture policy and peer lifetime.
export const name = 'dsh-t3code-access-gate-fixture'
export const inject = ['connection', 'remoteAccess', 'typertGateway']

const principal = {
  kind: 'share-viewer',
  shareId: 'sidebar-a10',
  actor: { providerId: 'fixture', tenantId: 'fixture', subjectId: 'viewer' },
}
const taskEndpoints = [
  'getSnapshot', 'follow', 'command', 'setPolicy', 'previewPolicy', 'listTransitions',
].map(method => `t3Sidebar/${method}`)

export function apply(ctx) {
  if (process.env.DSH_T3_A10_FIXTURE !== '1') return
  // The GUI fixture needs shell event delivery; API-only tests keep the
  // least-privilege default and do not enable interactions.
  const interactions = process.env.DSH_T3_A10_INTERACTIONS === 'answer' ? 'answer' : 'none'
  const peer = ctx.connection.createPeer({ principal, interactions })
  const handler = ctx.connection.createSharedFetchHandler('/api')
  const streams = new Map()
  let visibleSession = null
  let visibleWorkspace = null
  let taskGrant = false
  ctx.remoteAccess.registerPolicy(principal.kind, {
    bindings: () => [
      {
        resource: { kind: 'global' },
        role: { actions: ['session/list', 'workspace/follow', ...(taskGrant ? taskEndpoints : [])] },
      },
      ...(visibleWorkspace === null ? [] : [{
        resource: { kind: 'workspace', id: visibleWorkspace },
        role: { actions: ['workspace/follow'] },
      }]),
      ...(visibleSession === null ? [] : [{
        resource: { kind: 'session', id: visibleSession },
        role: { actions: ['session/list'] },
      }]),
    ],
  })
  ctx.connection.fetch.register({
    path: '/api/t3-a10-fixture',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const input = await request.json()
      switch (input.op) {
        case 'configure':
          visibleSession = input.visibleSession
          visibleWorkspace = input.visibleWorkspace ?? null
          taskGrant = input.taskGrant
          ctx.remoteAccess.invalidate(principal)
          return Response.json({ configured: true })
        case 'dispose':
          await peer.dispose()
          return Response.json({ disposed: true })
        case 'call':
          return await handler.fetch(new Request(new URL(input.path, request.url), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input.body),
            signal: request.signal,
          }), peer)
        case 'stream-open': {
          const abort = new AbortController()
          try {
            const uplink = { async *[Symbol.asyncIterator]() {} }
            const source = await ctx.typertGateway.wireStream.open(input.endpoint, input.payload, uplink, peer, abort.signal)
            streams.set(input.id, { abort, iterator: source[Symbol.asyncIterator]() })
            return Response.json({ opened: true })
          } catch (error) {
            return Response.json({ failure: ctx.typertGateway.wireStream.failure(error) })
          }
        }
        case 'stream-next': {
          const stream = streams.get(input.id)
          if (stream === undefined) return Response.json({ end: true })
          try {
            const result = await stream.iterator.next()
            if (result.done) streams.delete(input.id)
            return Response.json(result.done ? { end: true } : { value: result.value })
          } catch (error) {
            streams.delete(input.id)
            return Response.json({ failure: ctx.typertGateway.wireStream.failure(error) })
          }
        }
        case 'stream-cancel': {
          const stream = streams.get(input.id)
          streams.delete(input.id)
          stream?.abort.abort()
          await stream?.iterator.return?.()
          return Response.json({ cancelled: true })
        }
        default:
          return Response.json({ error: 'unknown fixture operation' }, { status: 400 })
      }
    },
  })
}
