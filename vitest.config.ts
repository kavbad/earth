import { defineConfig } from 'vitest/config'

// Root-level unit tests cover the repository scripts (scripts/**). Workspace
// packages each carry their own vitest config and are run through turbo.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
    environment: 'node',
  },
})
