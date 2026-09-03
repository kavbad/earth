/**
 * Making people. `createHumanViaClaim` walks the real claim UI (spec §44–§49) end to end — gate,
 * group, email one-time code, identity, Human Pass (the `mock` provider), "You're on Earth." —
 * and leaves the page inside the group's conversation. Nothing here reaches around the product:
 * every step is a click or a keystroke a person would make.
 *
 * Journeys must be independent, so every run mints its own addresses and names from `runId()`.
 * The seeded fixtures below are read-only: journeys may look at them, never change them.
 */
import { type Page, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'

import { copy, webCopy } from './copy'
import { extractConfirmationLink, readLatestOtp, readLatestOtpMail } from './otp'
import { anonKey, gatewayURL } from './stack'

// ---------------------------------------------------------------------------------------------
// Unique identities per run
// ---------------------------------------------------------------------------------------------

/** Addresses only Mailpit ever sees (the local stack's SMTP sink). */
export const E2E_EMAIL_DOMAIN = 'e2e.earth.local'

let cachedRunId: string | undefined
let counter = 0

/**
 * One id per test process, stable for its whole run: `runId()` in an address or a name is what
 * keeps two runs — and the two Playwright workers of one run — from colliding.
 */
export function runId(): string {
  cachedRunId ??= `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
  return cachedRunId
}

function nextSuffix(): string {
  counter += 1
  return `${runId()}${counter.toString(36)}`
}

/** `a-mgk1f3z71@e2e.earth.local` — never used before, never used again. */
export function uniqueEmail(label = 'person'): string {
  return `${label.toLowerCase()}-${nextSuffix()}@${E2E_EMAIL_DOMAIN}`
}

/** A display name nobody else has, so the suggested handle is free (`Ada mgk1f3z71`). */
export function uniqueName(label = 'Person'): string {
  return `${label} ${nextSuffix()}`
}

/** Read-only seed fixtures (supabase/seed/README.md). Journeys must never mutate them. */
export const FIXTURE_EMAILS = {
  xavier: 'xavier@fixtures.earth.local',
  maya: 'maya@fixtures.earth.local',
  kavon: 'kavon@fixtures.earth.local',
  sarah: 'sarah@fixtures.earth.local',
  ben: 'ben@fixtures.earth.local',
  chris: 'chris@fixtures.earth.local',
  alex: 'alex@fixtures.earth.local',
  sam: 'sam@fixtures.earth.local',
} as const

export type FixtureName = keyof typeof FIXTURE_EMAILS

/** Their display names, as `supabase/seed/010_fixtures.sql` writes them. */
export const FIXTURE_NAMES: Readonly<Record<FixtureName, string>> = {
  xavier: 'Xavier',
  maya: 'Maya',
  kavon: 'Kavon',
  sarah: 'Sarah',
  ben: 'Ben',
  chris: 'Chris',
  alex: 'Alex',
  sam: 'Sam',
}

/** The known plaintext invite tokens of the seeded groups (supabase/seed/README.md). */
export const FIXTURE_INVITE_TOKENS = {
  weekendCrew: 'weekend-crew-dev-token',
  college: 'college-dev-token',
} as const

// ---------------------------------------------------------------------------------------------
// The claim flow
// ---------------------------------------------------------------------------------------------

export type ClaimIntent = 'start_group' | 'join_group'

export interface CreateHumanOptions {
  readonly email: string
  readonly displayName: string
  readonly intent: ClaimIntent
  /** `start_group` only; omitted means "Skip" on the optional-name step (spec §45 step 2). */
  readonly groupName?: string | undefined
  /** `join_group` only: the invite token or the whole `/g/<token>` link. */
  readonly inviteToken?: string | undefined
}

export interface ClaimedHuman {
  readonly email: string
  readonly displayName: string
  /** The handle the identity step settled on (suggested from the display name). */
  readonly handle: string
  /** `/chats/<conversationId>` — where "Enter …" on the welcome screen lands. */
  readonly conversationUrl: string
  readonly conversationId: string
}

const CONVERSATION_URL = /\/chats\/[0-9a-f-]{36}$/

/** Step 1 — the membership gate (spec §44), and the group choice it opens. */
async function chooseGroup(page: Page, options: CreateHumanOptions): Promise<void> {
  await page.goto('/claim')
  await expect(page.getByRole('heading', { name: copy.claimGate })).toBeVisible()

  if (options.intent === 'join_group') {
    const token = options.inviteToken
    if (token === undefined || token === '') {
      throw new Error('createHumanViaClaim({ intent: "join_group" }) needs an inviteToken')
    }
    await page.getByRole('button', { name: copy.joinGroup }).click()
    await page.getByRole('textbox', { name: webCopy.inviteLinkLabel }).fill(token)
    await page.getByRole('button', { name: copy.joinThem }).click()
    return
  }

  await page.getByRole('button', { name: copy.startGroup }).click()
  await expect(page.getByRole('heading', { name: copy.optionalGroupName })).toBeVisible()
  if (options.groupName === undefined || options.groupName === '') {
    await page.getByRole('button', { name: copy.skip }).click()
    return
  }
  await page.getByRole('textbox', { name: webCopy.groupNameLabel }).fill(options.groupName)
  await page.getByRole('button', { name: webCopy.continue }).click()
}

/** Step 2 — the credential: email, then the six-digit code Mailpit received (spec §45 step 4). */
async function enterCredential(page: Page, email: string): Promise<void> {
  const emailField = page.getByRole('textbox', { name: webCopy.emailLabel })
  await expect(emailField).toBeVisible()
  await emailField.fill(email)
  const sentAt = new Date()
  await page.getByRole('button', { name: webCopy.sendCode }).click()

  const codeField = page.getByRole('textbox', { name: webCopy.codeLabel })
  await expect(codeField).toBeVisible()
  await codeField.fill(await readLatestOtp(email, { after: sentAt }))
  await page.getByRole('button', { name: webCopy.continue }).click()
}

/** Step 3 — public identity; the handle is suggested and must read "Available" (spec §45 step 5). */
async function setIdentity(page: Page, displayName: string): Promise<string> {
  const nameField = page.getByRole('textbox', { name: copy.displayName })
  await expect(nameField).toBeVisible()
  await nameField.fill(displayName)

  const handleField = page.getByRole('textbox', { name: copy.handle })
  const submit = page.getByRole('button', { name: webCopy.continue })
  // Enabled only once the suggested handle came back available — no sleeping on the debounce.
  await expect(submit).toBeEnabled()
  await expect(page.getByText(webCopy.handleAvailable)).toBeVisible()
  const handle = await handleField.inputValue()
  await submit.click()
  return handle
}

/** Step 4 — Human Pass through the `mock` provider (HUMAN_VERIFICATION_PROVIDER=mock, spec §111). */
async function proveHuman(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: copy.proveHuman })).toBeVisible()
  // The mock provider's outcome picker defaults to `verified`; being explicit keeps the journey
  // readable and immune to a changed default.
  const outcome = page.getByRole('combobox', { name: webCopy.mockOutcomeLabel })
  if ((await outcome.count()) > 0) await outcome.selectOption('verified')
  await page.getByRole('button', { name: webCopy.startVerification }).click()
}

export interface FinishClaimOptions {
  readonly email: string
  readonly displayName: string
  /** The group's name, when it has one: the §49 CTA reads `Enter <name>` rather than the neutral line. */
  readonly groupName?: string | undefined
}

/**
 * Everything after the group is chosen — credential, identity, Human Pass, "You're on Earth." and
 * the one CTA into the group's conversation. Journeys whose person enters somewhere other than
 * the gate (spec §46: "Join them" on a `/g/<token>` preview) continue here.
 */
export async function finishClaim(page: Page, options: FinishClaimOptions): Promise<ClaimedHuman> {
  await enterCredential(page, options.email)
  const handle = await setIdentity(page, options.displayName)
  await proveHuman(page)

  // Spec §49 — "You're on Earth.", then one CTA into the group's conversation.
  await page.waitForURL('**/welcome', { timeout: 60_000 })
  await expect(page.getByRole('heading', { name: copy.youreOnEarth })).toBeVisible()
  const enter = page.getByRole('button', {
    name:
      options.groupName === undefined || options.groupName === ''
        ? webCopy.enterYourGroup
        : copy.enterGroup(options.groupName),
  })
  await expect(enter).toBeEnabled()
  await enter.click()

  await page.waitForURL(CONVERSATION_URL)
  const conversationUrl = page.url()
  return {
    email: options.email,
    displayName: options.displayName,
    handle,
    conversationUrl,
    conversationId: new URL(conversationUrl).pathname.split('/').pop() ?? '',
  }
}

/**
 * Claims a place the way a person does, from the gate. Returns once the group's conversation is
 * open, so the caller can go straight on to sending a message.
 */
export async function createHumanViaClaim(
  page: Page,
  options: CreateHumanOptions,
): Promise<ClaimedHuman> {
  await chooseGroup(page, options)
  return finishClaim(page, options)
}

// ---------------------------------------------------------------------------------------------
// Signing an existing Human back in
// ---------------------------------------------------------------------------------------------

export interface SignInOptions {
  /** Where to land afterwards; same-origin path only (`lib/routes.ts` `safeNextPath`). */
  readonly next?: string
  readonly timeoutMs?: number
}

/**
 * Signs an existing Human (a seed fixture, or someone this journey already claimed) back in with
 * an email one-time code. The claim gate is for claiming — the flag `GROUP_ANCHORED_CLAIM_REQUIRED`
 * makes every entry there choose a group — so this asks GoTrue for the code and hands the token
 * from that same email to the app's own `/auth/callback`, which is what an OTP email link does.
 */
export async function signInExisting(
  page: Page,
  email: string,
  options: SignInOptions = {},
): Promise<void> {
  const key = anonKey()
  if (key === '') {
    throw new Error('no NEXT_PUBLIC_SUPABASE_ANON_KEY: is the local stack up (.local/stack.env)?')
  }
  const sentAt = new Date()
  const response = await fetch(`${gatewayURL()}/auth/v1/otp`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email, create_user: false }),
  })
  if (!response.ok) {
    throw new Error(
      `GoTrue refused a code for ${email}: ${response.status} ${await response.text()}`,
    )
  }

  const mail = await readLatestOtpMail(email, {
    after: sentAt,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const link = extractConfirmationLink(mail.html)
  if (link === null) throw new Error(`no sign-in link in the code email for ${email}`)

  const next = options.next ?? '/home'
  const query = new URLSearchParams({ token_hash: link.token, type: link.type, next })
  await page.goto(`/auth/callback?${query.toString()}`)
  await page.waitForURL(`**${next}`)

  const cookies = await page.context().cookies()
  if (!cookies.some((cookie) => cookie.name.startsWith('sb-'))) {
    throw new Error(`signing ${email} in left no Supabase session cookie`)
  }
}
