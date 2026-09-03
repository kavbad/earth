import { defineConfig, devices } from '@playwright/test'

import { baseURL } from './fixtures/stack'

/**
 * The twelve journeys of spec §116 against the local stack (ARCHITECTURE.md §15).
 *
 * `global-setup.ts` starts the stack and the web app for the run and `global-teardown.ts` stops
 * them; `E2E_EXTERNAL_STACK=1` says both are already running and must be left alone.
 *
 * Chromium's fake media devices let camera and microphone journeys run headlessly, and the
 * browser comes from `PLAYWRIGHT_BROWSERS_PATH` — never run `playwright install` here.
 */
const FAKE_MEDIA_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]

/** Opening a report needs a terminal; CI and piped runs just leave it on disk. */
const htmlOpen =
  process.env['CI'] === undefined && process.stdout.isTTY === true ? 'on-failure' : 'never'

export default defineConfig({
  testDir: './journeys',
  outputDir: './test-results',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // One journey at a time inside a file, two files side by side: enough parallelism to keep a run
  // short without two journeys fighting over the single LiveKit and Mailpit.
  fullyParallel: false,
  workers: 2,
  // One retry, only so `on-first-retry` has a retry to record a trace on. A journey that needs the
  // retry to pass is a bug in the journey or in the product — never leave one there.
  retries: 1,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: htmlOpen }]],
  use: {
    baseURL: baseURL(),
    trace: 'on-first-retry',
    video: 'off',
    screenshot: 'only-on-failure',
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
})
