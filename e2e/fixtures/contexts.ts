/**
 * One browser context per person. Different people (A / B / C, a Guest) must never share cookies:
 * the session lives in cookies (`@supabase/ssr`'s `createBrowserClient`), so a second `page` in
 * the same context would be the same Human.
 *
 * Camera and microphone are granted up front and Chromium runs with fake media devices
 * (`playwright.config.ts`), so Live and room journeys never wait on a permission prompt.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test'

import { baseURL } from './stack'

export const MEDIA_PERMISSIONS = ['camera', 'microphone'] as const

export interface Person {
  readonly context: BrowserContext
  readonly page: Page
  /** Closes the context (and every page in it). */
  close(): Promise<void>
}

export interface NewPersonOptions {
  /** Desktop Chrome's default; journeys that need the narrow layout can override it. */
  readonly viewport?: { readonly width: number; readonly height: number }
  readonly permissions?: readonly string[]
}

async function open(browser: Browser, options: NewPersonOptions): Promise<Person> {
  const context = await browser.newContext({
    baseURL: baseURL(),
    viewport: { ...(options.viewport ?? { width: 1280, height: 720 }) },
    permissions: [...(options.permissions ?? MEDIA_PERMISSIONS)],
  })
  const page = await context.newPage()
  return { context, page, close: () => context.close() }
}

/** A person who will claim a place or sign in — A, B, C. */
export function newPerson(browser: Browser, options: NewPersonOptions = {}): Promise<Person> {
  return open(browser, options)
}

/**
 * Someone with no account and no Earth session, opening a room link in their browser
 * (spec §46 / E2E 7). Same media permissions — a Guest joins with camera or audio — but a fresh,
 * empty storage state, which is what makes them a Guest.
 */
export function newGuest(browser: Browser, options: NewPersonOptions = {}): Promise<Person> {
  return open(browser, options)
}

/** Closes several people in one line, even if one of them already went away. */
export async function closeAll(...people: readonly Person[]): Promise<void> {
  await Promise.all(people.map((person) => person.close().catch(() => undefined)))
}
