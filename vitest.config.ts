import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Calendar tests (DST gaps) assume this zone; workers inherit it.
process.env.TZ = 'America/New_York'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-storage-domain': fileURLToPath(new URL('./tests/stubs/storage-domain.ts', import.meta.url)),
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/stubs/ui-primitives.tsx', import.meta.url)),
    },
  },
  esbuild: { target: 'es2022' },
  test: { include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'] },
})
