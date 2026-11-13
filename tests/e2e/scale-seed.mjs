// Seed an isolated, not-yet-started DSH_HOME with synthetic history for the
// Q02 scale run: <workspaces> directories × <perWorkspace> sessions, each a
// copy of one real completed session log (session.v4.jsonl.zstd) with a new
// id, cwd and shifted timestamps, plus a workspace registry listing them.
// Never point this at a real profile: it writes `storages/workspace.json`.
//
// Usage: node tests/e2e/scale-seed.mjs <dsh-home> <workspace-root> <template-log.zstd> [workspaces=100] [perWorkspace=50]
// Needs the `zstd` CLI (logs are concatenated zstd frames).
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [home, root, template, workspaceCount = '100', perWorkspace = '50'] = process.argv.slice(2)
if (home === undefined || root === undefined || template === undefined) {
  console.error('usage: scale-seed.mjs <dsh-home> <workspace-root> <template-log.zstd> [workspaces] [perWorkspace]')
  process.exit(2)
}
if (existsSync(join(home, 'storages', 'workspace.json'))) {
  console.error('refusing to overwrite an existing workspace registry; use a fresh DSH_HOME')
  process.exit(2)
}

const text = execFileSync('zstd', ['-dc', template]).toString('utf8')
const lines = text.split('\n').filter(line => line !== '')
const header = JSON.parse(lines[0])
const oldId = header.id
const oldCwd = header.cwd
const oldCreated = header.createdAt

/** Session directories are keyed by the cwd with every "/" turned into "-", wrapped as "-…--". */
const dirOf = cwd => `-${cwd.replaceAll('/', '-')}--`

const DAY = 24 * 3_600_000
const now = Date.now()
const workspaces = {}
const workspaceIds = []
let total = 0
for (let w = 0; w < Number(workspaceCount); w += 1) {
  const path = join(root, `w${String(w).padStart(3, '0')}`)
  await mkdir(path, { recursive: true })
  const sessionIds = []
  for (let s = 0; s < Number(perWorkspace); s += 1) {
    const id = `session-${randomUUID()}`
    // Spread creation over the last 30 days so sorting and "N ago" vary.
    const created = now - Math.floor(((w * Number(perWorkspace) + s) / (Number(workspaceCount) * Number(perWorkspace))) * 30 * DAY) - 60_000
    const delta = created - oldCreated
    const rewritten = lines.map((line, index) => {
      let next = line.replaceAll(oldId, id).replaceAll(JSON.stringify(oldCwd).slice(1, -1), path)
      if (index === 0) next = next.replace(/"createdAt":\d+/, `"createdAt":${created}`)
      return next.replace(/"time":(\d+)/g, (_match, time) => `"time":${Number(time) + delta}`)
    })
    const dir = join(home, 'sessions', dirOf(path), id)
    await mkdir(dir, { recursive: true })
    // The format requires a first checksummed frame holding only the header
    // line, then one frame per append batch (here: one batch with the rest).
    const frame = text => execFileSync('zstd', ['-q', '-c', '--check'], { input: text })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
      frame(`${rewritten[0]}\n`),
      frame(`${rewritten.slice(1).join('\n')}\n`),
    ]))
    sessionIds.push(id)
    total += 1
  }
  const workspaceId = randomUUID()
  const stamp = new Date(now).toISOString()
  workspaces[workspaceId] = { path, title: `w${String(w).padStart(3, '0')}`, sessionIds: sessionIds.reverse(), createdAt: stamp, updatedAt: stamp }
  workspaceIds.push(workspaceId)
}

await mkdir(join(home, 'storages'), { recursive: true })
await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds, archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces },
}, null, 2))
console.log(`seeded ${workspaceIds.length} workspaces, ${total} sessions from ${oldId}`)
