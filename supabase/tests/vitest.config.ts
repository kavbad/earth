import { defineConfig } from 'vitest/config'

// The global setup builds one migrated template database per run; each test file clones it into a
// scratch database (ARCHITECTURE.md §15), so files run in parallel in separate processes and get a
// generous timeout for database creation.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/vitest.globalSetup.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: true,
    pool: 'forks',
  },
})
