import { defineConfig, devices } from '@playwright/test'

export const DEFAULT_BASE_URL = 'http://localhost:3000'
export const HEALTH_PATH = '/api/health'

const baseURL = process.env.E2E_BASE_URL ?? DEFAULT_BASE_URL

// Chromium fake media devices let journeys exercise camera/mic flows headlessly
// (ARCHITECTURE.md §15). Chromium itself comes from PLAYWRIGHT_BROWSERS_PATH; never run
// `playwright install` here.
const FAKE_MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']

export default defineConfig({
  testDir: './journeys',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    permissions: ['camera', 'microphone'],
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: FAKE_MEDIA_ARGS },
      },
    },
  ],
  // When no stack provides E2E_BASE_URL, start the web app so journeys can run standalone.
  // With the local stack up (scripts/local-stack) the running server is reused.
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'pnpm --filter earth-web dev',
          url: `${DEFAULT_BASE_URL}${HEALTH_PATH}`,
          reuseExistingServer: true,
          timeout: 180_000,
        },
      }),
})
