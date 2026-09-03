import { expect, test } from '@playwright/test'

import { HEALTH_PATH } from '../playwright.config'

test.describe('smoke', () => {
  test('web server answers /api/health', async ({ request }) => {
    const response = await request.get(HEALTH_PATH)
    expect(response.ok()).toBe(true)
    await expect(response.json()).resolves.toEqual({ ok: true, service: 'earth-web' })
  })

  test('home page renders the wordmark', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'earth' })).toBeVisible()
  })
})
