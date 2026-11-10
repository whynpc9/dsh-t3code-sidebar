// Build both faces of dsh-t3code-sidebar.
//
// Host face: `src/index.ts` → `lib/index.js` (ESM, Node). DSH packages and
// Cordis stay external so the running installation's copies are used.
//
// Client face: `src/client/index.tsx` → `lib/client.js` wrapped in the
// lazy-CJS Loader protocol the Harness module system expects:
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
// Every request answered by the browser platform module table stays external.
// CSS files are imported as text and injected as <style data-plugin=…> tags,
// matching the convention official bundles use so unload removes them.

import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

/** Browser platform module table of @deepseek-ai/dsh-web 0.2.2-rc.1 (PLATFORM_MODULES). */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const cssAsText = {
  name: 'css-as-text',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await readFile(args.path, 'utf8')
      const tagId = `${pkg.name}/${args.path.slice(root.length + 1)}`
      const contents = `
const css = ${JSON.stringify(css)};
const tagId = ${JSON.stringify(tagId)};
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style');
  tag.dataset.plugin = ${JSON.stringify(pkg.name)};
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}
export default tagId;
`
      return { contents, loader: 'js' }
    })
  },
}

const common = {
  bundle: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
}

await mkdir(resolve(root, 'lib'), { recursive: true })

// ── Host face ────────────────────────────────────────────────────────────────
await build({
  ...common,
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'lib/index.js'),
  platform: 'node',
  format: 'esm',
  external: ['@deepseek-ai/*', 'node:*'],
})

// Guard: SRC dispatch reads Host parameter names from the emitted functions,
// so every Remote method must keep exactly the wire names of REMOTE_SPEC.
{
  const hostJs = await readFile(resolve(root, 'lib/index.js'), 'utf8')
  const specFile = resolve(root, 'scripts/.remote-spec.mjs')
  await build({ ...common, entryPoints: [resolve(root, 'src/contracts/remote.ts')], outfile: specFile, platform: 'node', format: 'esm' })
  const { REMOTE_SPEC } = await import(`${specFile}?t=${Date.now()}`)
  for (const [endpoint, method] of Object.entries(REMOTE_SPEC.methods)) {
    const name = endpoint.split('/')[1]
    const wire = method.parameters.map(parameter => parameter.name)
    if (method.cancellation !== undefined) wire.push('signal')
    const match = new RegExp(`\\n  (?:async )?${name}\\(([^)]*)\\) \\{`).exec(hostJs)
    const emitted = match?.[1].split(',').map(part => part.trim()).filter(Boolean)
    if (JSON.stringify(emitted) !== JSON.stringify(wire)) {
      throw new Error(`Remote ${endpoint}: emitted parameters ${JSON.stringify(emitted)} differ from wire ${JSON.stringify(wire)}`)
    }
  }
}

// ── Client face ──────────────────────────────────────────────────────────────
const client = await build({
  ...common,
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  write: false,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  plugins: [cssAsText],
})
const body = client.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
await writeFile(resolve(root, 'lib/client.js'), wrapped)

// Guard: the client bundle must not carry its own React or Cordis copy.
for (const marker of ['react.production.min.js', 'Symbol.for("react.element")', 'ReactCurrentOwner']) {
  if (wrapped.includes(marker)) throw new Error(`client bundle embeds a private React copy (${marker})`)
}
const kib = (Buffer.byteLength(wrapped) / 1024).toFixed(1)
console.log(`built lib/index.js and lib/client.js (${kib} KiB)`)
