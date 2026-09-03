import { expect, test } from '@playwright/test'

import { HEALTH_PATH } from '../playwright.config'

test.describe('smoke', () => {
  test('web server answers /api/health with a ready server tier', async ({ request }) => {
    const response = await request.get(HEALTH_PATH)
    expect(response.ok()).toBe(true)
    // `lib/server/health.ts`: `{ ok, service, release, serverTier }`; 503 + `issues` when the
    // environment is invalid — which is what a web server started without one answers.
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: 'earth-web',
      serverTier: 'ready',
    })
  })

  test('home page renders the wordmark', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'earth' })).toBeVisible()
  })
})
