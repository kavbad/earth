/**
 * Shared expectations. Both are role-based on purpose: journeys assert what a person can see and
 * hear, never a class name.
 */
import { type Locator, type Page, expect } from '@playwright/test'

/**
 * The one toast line (`components/ui/Toast.tsx` renders the viewport as `role="status"`,
 * `aria-live="polite"`). Toasts disappear after `TOAST_DURATION_MS`, so assert promptly.
 */
export async function expectToast(page: Page, message: string): Promise<void> {
  await expect(page.getByRole('status').getByText(message, { exact: true })).toBeVisible()
}

/** A visible copy string, anywhere on the page — for lines that carry no role of their own. */
export async function expectVisibleCopy(page: Page, text: string): Promise<Locator> {
  const locator = page.getByText(text, { exact: true }).first()
  await expect(locator).toBeVisible()
  return locator
}
