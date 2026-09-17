/**
 * E2E 9 — Audience integrity (spec §116): "Friends post cannot become visible to noneligible
 * stranger."
 *
 * The rule under test is spec §71/§72 as `earth.can_view_post` implements it: a Friends post
 * reaches the author's friends and nobody else — not through the feed, not through the author's
 * profile, not through the post's own public link — and a reply can never carry the thread wider
 * than its root.
 *
 * 1. A, F and S each claim their own place (SCREEN 22 identities of their own); F asks A to be
 *    friends and A accepts. S never meets A: no friendship, no group, no follow.
 * 2. A posts "friends only <runId>" from Home's Friends radius, with the composer's audience
 *    button reading `Audience: Friends` before Post is pressed (SCREEN 06).
 * 3. S — a Human with no relationship to A — opens A's profile: it loads, and "Now" says
 *    `Nothing posted yet.` The post's text is nowhere on the page.
 * 4. S opens `/p/<postId>` directly: the post is not visible (`This post isn't available.`), and
 *    the text never appears — existence is not revealed by leaking the body.
 * 5. A visitor (no session at all) opens the same link and gets the same nothing.
 * 6. A's friend F sees the post on Home → Friends and on A's profile, with `· Friends` in its
 *    meta line, and opens it from there.
 * 7. F replies. The inline composer states the cap (`Replies stay within Friends.`) and the reply
 *    lands at Friends. F then opens the full reply composer and tries to widen: the audience
 *    control offers Friends only — Neighborhood, City and World are absent (spec §72).
 *
 * Everyone here is made by this journey through the real claim UI with `runId()` addresses, so it
 * never touches the seeded fixtures and two runs never collide.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { closeAll, newGuest, newPerson } from '../fixtures/contexts'
import { copy, feedCopy, postCopy, profileCopy } from '../fixtures/copy'
import { createHumanViaClaim, runId, uniqueEmail, uniqueName } from '../fixtures/people'

/** SCREEN 01–05 Home, and SCREEN 07 at `/p/<postId>` (spec §112). */
const HOME = '/home'
const POST_URL = /\/p\/[0-9a-f-]{36}$/
const COMPOSE_URL = /\/compose\?/
/** `DEEP_LINK_PATHS.profile` — SCREEN 22 at `/@handle` (`next.config.ts` rewrites it to `/u`). */
const profilePath = (handle: string): string => `/@${handle}`

/**
 * One post wherever it is rendered (Home, profile, thread): `PostCard`'s `<article>`, named for
 * its author and its own text. Absence of this is the product fact this journey is about.
 */
function postArticle(page: Page, authorName: string, text: string): Locator {
  return page.getByRole('article', { name: `${authorName}: ${text}` })
}

/** `2m · Friends` — the audience half of a post's meta line (spec §29, SCREEN 06–07). */
function audienceMeta(audienceLabel: string): RegExp {
  return new RegExp(`· ${audienceLabel}$`)
}

/** The composer's audience button, which names the audience it will post to (SCREEN 06). */
function audienceButton(page: Page, audienceLabel: string): Locator {
  return page.getByRole('button', {
    name: `${copy.audience}: ${audienceLabel}`,
    exact: true,
  })
}

test('E2E 9 — Audience integrity', async ({ browser }) => {
  const a = await newPerson(browser)
  const f = await newPerson(browser)
  const s = await newPerson(browser)
  // No session, no account, no storage — a Visitor with nothing but the link (spec §43).
  const visitor = await newGuest(browser)

  const nameA = uniqueName('Ada')
  const nameF = uniqueName('Fern')
  const nameS = uniqueName('Sol')
  const postBody = `friends only ${runId()}`
  const replyBody = `stays with the friends ${runId()}`

  try {
    // ------------------------------------------------------------------ three unrelated Humans
    const [humanA, humanF] = await Promise.all([
      createHumanViaClaim(a.page, {
        email: uniqueEmail('a'),
        displayName: nameA,
        intent: 'start_group',
      }),
      createHumanViaClaim(f.page, {
        email: uniqueEmail('f'),
        displayName: nameF,
        intent: 'start_group',
      }),
      createHumanViaClaim(s.page, {
        email: uniqueEmail('s'),
        displayName: nameS,
        intent: 'start_group',
      }),
    ])

    // ------------------------------------------------------------------ F and A become friends
    // SCREEN 22: F asks, A accepts. S is never part of this — no friendship, no shared group.
    await f.page.goto(profilePath(humanA.handle))
    await expect(f.page.getByRole('heading', { name: nameA, exact: true }).first()).toBeVisible()
    await f.page.getByRole('button', { name: copy.profileActions.addFriend, exact: true }).click()
    await expect(
      f.page.getByRole('button', { name: profileCopy.requested, exact: true }),
    ).toBeVisible()

    await a.page.goto(profilePath(humanF.handle))
    await expect(a.page.getByRole('heading', { name: nameF, exact: true }).first()).toBeVisible()
    await a.page.getByRole('button', { name: profileCopy.accept, exact: true }).click()
    await expect(
      a.page.getByRole('button', { name: copy.profileActions.friends, exact: true }),
    ).toBeVisible()

    // ------------------------------------------------------------------ A posts to Friends
    // Friends is the member default radius (spec §51), and SCREEN 06 opens with it as the audience.
    await a.page.goto(HOME)
    await expect(
      a.page.getByRole('tab', { name: copy.scopes.friends, selected: true }),
    ).toBeVisible()
    await a.page.getByRole('link', { name: feedCopy.newPost }).click()
    await a.page.waitForURL(COMPOSE_URL)
    await expect(audienceButton(a.page, copy.audiences.friends)).toBeVisible()
    await a.page.getByRole('textbox', { name: postCopy.textLabel }).fill(postBody)
    await a.page.getByRole('button', { name: copy.post, exact: true }).click()

    await a.page.waitForURL(POST_URL)
    const postId = new URL(a.page.url()).pathname.split('/').pop() ?? ''
    expect(postId).toMatch(/^[0-9a-f-]{36}$/)
    const postPath = `/p/${postId}`
    const ownCard = postArticle(a.page, nameA, postBody)
    await expect(ownCard).toBeVisible()
    await expect(ownCard.getByText(audienceMeta(copy.audiences.friends))).toBeVisible()

    // ------------------------------------------------------------------ S: a stranger sees none of it
    // A's profile loads for S — a public profile is public (spec §43) — but "Now" is empty: the
    // only thing A has posted is not for S.
    await s.page.goto(profilePath(humanA.handle))
    await expect(s.page.getByRole('heading', { name: nameA, exact: true }).first()).toBeVisible()
    // S really is a signed-in Human looking at A — the friend action proves the session — and
    // simply not eligible for the post. Without this the emptiness below could be a broken page.
    await expect(
      s.page.getByRole('button', { name: copy.profileActions.addFriend, exact: true }),
    ).toBeVisible()
    await expect(s.page.getByText(profileCopy.noPostsYet, { exact: true })).toBeVisible()
    await expect(postArticle(s.page, nameA, postBody)).toHaveCount(0)
    await expect(s.page.getByText(postBody, { exact: true })).toHaveCount(0)

    // The direct link is no way around it: not visible, and the text is never rendered.
    await s.page.goto(postPath)
    await expect(s.page.getByText(postCopy.postUnavailable, { exact: true })).toBeVisible()
    await expect(postArticle(s.page, nameA, postBody)).toHaveCount(0)
    await expect(s.page.getByText(postBody, { exact: true })).toHaveCount(0)

    // ------------------------------------------------------------------ a visitor sees none of it
    // Nothing but the link: no Supabase session cookie anywhere in this context (spec §43).
    expect(
      (await visitor.context.cookies()).filter((cookie) => cookie.name.startsWith('sb-')),
    ).toHaveLength(0)
    await visitor.page.goto(postPath)
    await expect(visitor.page.getByText(postCopy.postUnavailable, { exact: true })).toBeVisible()
    await expect(postArticle(visitor.page, nameA, postBody)).toHaveCount(0)
    await expect(visitor.page.getByText(postBody, { exact: true })).toHaveCount(0)

    // ------------------------------------------------------------------ F, a friend, sees it
    await f.page.goto(HOME)
    await expect(
      f.page.getByRole('tab', { name: copy.scopes.friends, selected: true }),
    ).toBeVisible()
    const feedCard = postArticle(f.page, nameA, postBody)
    await expect(feedCard).toBeVisible()
    await expect(feedCard.getByText(audienceMeta(copy.audiences.friends))).toBeVisible()

    await f.page.goto(profilePath(humanA.handle))
    const profileCard = postArticle(f.page, nameA, postBody)
    await expect(profileCard).toBeVisible()
    await profileCard.getByRole('link', { name: postCopy.openPost }).click()
    await f.page.waitForURL(POST_URL)
    await expect(postArticle(f.page, nameA, postBody)).toBeVisible()

    // ------------------------------------------------------------------ F replies, capped at Friends
    // SCREEN 07's inline composer says how far a reply can go and offers no way past it (spec §72).
    const capLine = postCopy.audienceCapped(copy.audiences.friends)
    await expect(f.page.getByText(capLine, { exact: true })).toBeVisible()
    const replyBox = f.page.getByRole('textbox', { name: copy.reply, exact: true })
    await expect(replyBox).toBeVisible()
    await replyBox.fill(replyBody)
    await replyBox.press('Enter')

    const replyCard = postArticle(f.page, nameF, replyBody)
    await expect(replyCard).toBeVisible()
    await expect(replyCard.getByText(audienceMeta(copy.audiences.friends))).toBeVisible()

    // The full reply composer is where the audience control lives: it is capped at the root's.
    await f.page.getByRole('link', { name: postCopy.addPhotoVideo, exact: true }).click()
    await f.page.waitForURL(COMPOSE_URL)
    await expect(f.page.getByText(postCopy.replyingTo(nameA), { exact: true })).toBeVisible()
    const replyAudience = audienceButton(f.page, copy.audiences.friends)
    await expect(replyAudience).toBeVisible()
    await expect(audienceButton(f.page, copy.audiences.world)).toHaveCount(0)

    await replyAudience.click()
    const sheet = f.page.getByRole('dialog', { name: postCopy.audienceTitle })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText(capLine, { exact: true })).toBeVisible()
    await expect(
      sheet.getByRole('button', { name: copy.audiences.friends, pressed: true }),
    ).toBeVisible()
    for (const wider of ['neighborhood', 'city', 'world'] as const) {
      await expect(sheet.getByRole('button', { name: copy.audiences[wider] })).toHaveCount(0)
    }
  } finally {
    await closeAll(a, f, s, visitor)
  }
})
