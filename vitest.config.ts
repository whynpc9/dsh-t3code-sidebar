import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-storage-domain': fileURLToPath(new URL('./tests/stubs/storage-domain.ts', import.meta.url)),
    },
  },
  esbuild: { target: 'es2022' },
  test: { include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'] },
})
