/**
 * Screens — the design review's evidence. Signs the seed Human Ben in and photographs every
 * screen a person sees, as a visitor and as Ben, at a desktop and a phone size, into
 * `.local/screens/<tag>/`. Not a journey: nothing is asserted about the product except that no
 * request leaves the machine (the suite is hermetic; a font or a tile fetched from elsewhere is a
 * defect). Run against a running stack and web app:
 *
 *   pnpm stack:up && bash e2e/… (or `E2E_EXTERNAL_STACK=1` with your own server)
 *   pnpm exec tsx e2e/screens.ts <tag>
 *
 * Ben is read-only seed data (supabase/seed/README.md); the script writes nothing to his account.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { type Browser, type Page, chromium } from '@playwright/test'

import { FIXTURE_EMAILS, signInExisting } from './fixtures/people'
import { LOCAL_DIR, baseURL } from './fixtures/stack'

const SETTLE_MS = 1_800
const VIEWPORTS = {
  desk: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
} as const

/** Screens that need no session (SCREEN 01/02, the claim gate, the visitor map and Live). */
const VISITOR: ReadonlyArray<readonly [name: string, route: string]> = [
  ['00-home-visitor', '/home'],
  ['01-claim', '/claim'],
  ['02-claim-start', '/claim/start'],
  ['03-earth-visitor', '/earth'],
  ['04-live-visitor', '/live'],
]

/** Screens as Ben, by route; the few that need a click are handled in `captureHuman`. */
const HUMAN: ReadonlyArray<readonly [name: string, route: string, full?: boolean]> = [
  ['20-chats', '/chats'],
  ['23-chat-new', '/chats/new'],
  ['30-earth', '/earth'],
  ['40-live', '/live'],
  ['50-notifications', '/notifications', true],
  ['51-search', '/search'],
  ['53-compose', '/compose'],
  ['60-you', '/you', true],
  ['61-settings', '/you/settings'],
  ['62-settings-privacy', '/you/settings/privacy'],
  ['63-settings-identity', '/you/settings/identity'],
  ['70-profile-maya', '/u/maya', true],
]

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function outDir(tag: string): string {
  const dir = path.join(LOCAL_DIR, 'screens', tag)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function shot(page: Page, dir: string, name: string, full = false): Promise<void> {
  await page.waitForLoadState('load')
  await page.waitForTimeout(SETTLE_MS)
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: full })
  console.log(`  ${name}  ${page.url()}`)
}

function watchRequests(page: Page, leaks: string[]): void {
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname
    if (!LOCAL_HOSTS.has(host)) leaks.push(request.url())
  })
}

async function captureVisitor(
  browser: Browser,
  dir: string,
  size: keyof typeof VIEWPORTS,
  leaks: string[],
) {
  const context = await browser.newContext({
    baseURL: baseURL(),
    viewport: VIEWPORTS[size],
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  watchRequests(page, leaks)
  for (const [name, route] of VISITOR) {
    await page.goto(`${baseURL()}${route}`)
    await shot(page, dir, `${size}-${name}`)
  }
  await context.close()
}

async function captureHuman(
  browser: Browser,
  dir: string,
  size: keyof typeof VIEWPORTS,
  leaks: string[],
) {
  const context = await browser.newContext({
    baseURL: baseURL(),
    viewport: VIEWPORTS[size],
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  watchRequests(page, leaks)
  await signInExisting(page, FIXTURE_EMAILS.ben, { next: '/home' })
  await shot(page, dir, `${size}-10-home-friends`, true)
  await page.getByRole('tab', { name: 'Neighborhood', exact: true }).click()
  await shot(page, dir, `${size}-11-home-neighborhood`, true)
  await page.getByRole('tab', { name: 'World', exact: true }).click()
  await shot(page, dir, `${size}-12-home-world`, true)
  const post = await page.locator('a[href^="/p/"]').first().getAttribute('href')
  if (post !== null) {
    await page.goto(`${baseURL()}${post}`)
    await shot(page, dir, `${size}-13-post`, true)
  }
  await page.goto(`${baseURL()}/chats`)
  const chat = await page
    .locator('a[href^="/chats/"]:not([href$="/new"])')
    .first()
    .getAttribute('href')
  if (chat !== null) {
    await page.goto(`${baseURL()}${chat}`)
    await shot(page, dir, `${size}-21-chat`)
    await page.goto(`${baseURL()}${chat}/info`)
    await shot(page, dir, `${size}-22-chat-info`)
  }
  for (const [name, route, full] of HUMAN) {
    await page.goto(`${baseURL()}${route}`)
    await shot(page, dir, `${size}-${name}`, full === true)
    if (name === '30-earth') {
      await page.getByRole('button', { name: 'List', exact: true }).click()
      await shot(page, dir, `${size}-31-earth-list`)
    }
    if (name === '51-search') {
      await page.getByRole('searchbox').first().fill('Maya')
      await page.waitForTimeout(SETTLE_MS)
      await shot(page, dir, `${size}-52-search-results`)
    }
  }
  await context.close()
}

async function main(): Promise<void> {
  const tag = process.argv[2] ?? new Date().toISOString().replace(/[:.]/g, '-')
  const dir = outDir(tag)
  const leaks: string[] = []
  const browser = await chromium.launch()
  try {
    for (const size of ['desk', 'phone'] as const) {
      await captureVisitor(browser, dir, size, leaks)
      await captureHuman(browser, dir, size, leaks)
    }
  } finally {
    await browser.close()
  }
  console.log(`screens in ${dir}`)
  if (leaks.length > 0) {
    console.error(`requests left the machine:\n  ${[...new Set(leaks)].join('\n  ')}`)
    process.exitCode = 1
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
