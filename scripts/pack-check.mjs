// Verify the npm tarball contents: required runtime files present, nothing
// private (sources, tests, env files, absolute dev paths) shipped.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const listing = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }))[0]
const files = listing.files.map(file => file.path).sort()
const required = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'LICENSE', 'README.md']
const missing = required.filter(file => !files.includes(file))
const forbidden = files.filter(file => /^(src|tests|scripts|docs)\/|\.env|\.tgz$|node_modules/.test(file))
const problems = []
if (missing.length > 0) problems.push(`missing: ${missing.join(', ')}`)
if (forbidden.length > 0) problems.push(`forbidden: ${forbidden.join(', ')}`)
for (const file of ['lib/index.js', 'lib/client.js']) {
  const text = readFileSync(file, 'utf8')
  if (/\/home\/[a-z]+\/|\/Users\/[A-Za-z]+\/|\/tmp\/claude/.test(text)) problems.push(`${file} embeds an absolute development path`)
}
const client = readFileSync('lib/client.js', 'utf8')
if (!client.startsWith('window.__ModuleLoader__.load({')) problems.push('lib/client.js is not a Loader lazy-CJS bundle')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.dsh?.client?.platform !== 'web' || pkg.dsh?.bundle?.patch === undefined) problems.push('package.json dsh manifest incomplete')
const gzip = execFileSync('gzip', ['-c', 'lib/client.js']).length
console.log(`files: ${files.join(', ')}`)
console.log(`client bundle: ${(client.length / 1024).toFixed(1)} KiB raw, ${(gzip / 1024).toFixed(1)} KiB gzip (budget 250 KiB gzip)`)
if (gzip > 250 * 1024) problems.push('client bundle exceeds the 250 KiB gzip budget')
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('pack check ok')
