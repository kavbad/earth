/**
 * Proves the harness, not the product: one Human made the way every journey makes people —
 * through the real claim UI, with a code read out of Mailpit and the mock Human-verification
 * provider — landing on "You're on Earth." and then inside their group's conversation.
 *
 * If this fails, no journey below it can be trusted.
 */
import { expect, test } from '@playwright/test'

import { chatCopy, copy } from '../fixtures/copy'
import { newPerson } from '../fixtures/contexts'
import {
  FIXTURE_EMAILS,
  FIXTURE_NAMES,
  createHumanViaClaim,
  signInExisting,
  uniqueEmail,
  uniqueName,
} from '../fixtures/people'

test('the harness can claim a Human through the real claim UI', async ({ browser }) => {
  const person = await newPerson(browser)
  const groupName = uniqueName('Crew')

  try {
    const human = await createHumanViaClaim(person.page, {
      email: uniqueEmail('harness'),
      displayName: uniqueName('Ada'),
      intent: 'start_group',
      groupName,
    })

    // The claim ended where spec §49 says it ends, and the CTA opened the group's conversation.
    expect(human.handle).toMatch(/^[a-z0-9_]{3,24}$/)
    expect(person.page.url()).toBe(human.conversationUrl)
    await expect(person.page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/)

    // SCREEN 10: the group's name in the header, and a composer to write in.
    await expect(
      person.page.getByRole('link', { name: `${groupName} · ${chatCopy.openInfo}` }),
    ).toBeVisible()
    await expect(person.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()
  } finally {
    await person.close()
  }
})

test('the harness can sign an existing Human back in with an email code', async ({ browser }) => {
  const person = await newPerson(browser)

  try {
    // A read-only seed fixture (supabase/seed/README.md) — nothing here changes their data.
    await signInExisting(person.page, FIXTURE_EMAILS.xavier, { next: '/you' })
    await expect(
      person.page.getByRole('heading', { name: FIXTURE_NAMES.xavier, exact: true }),
    ).toBeVisible()
  } finally {
    await person.close()
  }
})
