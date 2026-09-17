/**
 * E2E 11 — Radius (spec §116): "Same Home UI → Friends/Neighborhood/City/World returns correctly
 * scoped data."
 *
 * The rule under test is spec §51/§52 as `feed_candidates` implements it: the radius is a
 * browsing context, not an audience. Changing it changes the content and nothing else — the same
 * document, the same header, the same control (§93) — and it never widens what an author chose:
 * a Friends-audience post is invisible from World.
 *
 * The viewer is a read-only seed fixture (supabase/seed/README.md): **Ben**, whose context is
 * San Francisco / Mission, exactly like Maya's. Ben rather than Maya because the journey has to
 * show a Neighborhood post that Friends does *not* have, and both Mission posts in the seed are
 * Maya's own or her friend Sarah's, so for Maya they appear under Friends too. Ben is in the
 * Mission with two friends (Chris and Sarah) and is not friends with Maya, so Maya's Dolores Park
 * moment is his neighborhood-but-not-friends post. Nothing here writes to a fixture's content;
 * the only trace is the remembered radius (spec §51), which a fresh browser context never reads.
 *
 * 1. Ben signs in with an email code and lands on Home at Friends — the member default (§51).
 * 2. Friends → Neighborhood → City → World, one click each. After every click: the URL is still
 *    `/home` and the document was never replaced (a marker set on `window` survives), the `earth`
 *    wordmark and the four-label radius control are still there, and exactly one tab is selected.
 * 3. The subtitle follows the radius: nothing at Friends, `Mission` at Neighborhood,
 *    `San Francisco` at City, nothing at World (SCREEN 02–05).
 * 4. The content changes, checked against the seeded post texts (supabase/seed/010_fixtures.sql):
 *    Friends has a friend's Friends post that Neighborhood, City and World do not; Neighborhood
 *    has a Mission post that Friends does not; City has a San Francisco post that Friends does
 *    not, and keeps the neighborhood post (the Mission is inside the city); World has the public
 *    posts of Humans Ben has never met — and never the Friends post.
 *
 * Every radius is asserted with its feed fully on screen ("That's everything for now."), so an
 * absent post is really absent and not merely on a later page.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { closeAll, newPerson } from '../fixtures/contexts'
import { APP_NAME, copy, feedCopy, webCopy } from '../fixtures/copy'
import { FIXTURE_EMAILS, FIXTURE_NAMES, signInExisting } from '../fixtures/people'

/** SCREEN 02–05 (spec §112): one route for all four radii. */
const HOME = '/home'

/** The four radii, in the order the control shows them (spec §51). */
type Radius = keyof typeof copy.scopes
const RADII: readonly Radius[] = ['friends', 'neighborhood', 'city', 'world']

/**
 * A property of this document, and only of this document: a radius change keeps it, any
 * navigation (a reload, a route change) would start a new document without it.
 */
const DOCUMENT_MARKER = '__earthRadiusJourney'

function markDocument(page: Page): Promise<void> {
  return page.evaluate((key) => {
    ;(window as unknown as Record<string, unknown>)[key] = true
  }, DOCUMENT_MARKER)
}

function documentIsMarked(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key] === true,
    DOCUMENT_MARKER,
  )
}

/** Ben's context as `010_fixtures.sql` sets it through `context_set` (`human_context`). */
const NEIGHBORHOOD_NAME = 'Mission'
const CITY_NAME = 'San Francisco'

/**
 * Seeded posts, quoted exactly from `supabase/seed/010_fixtures.sql`, with the radius each one
 * proves for Ben. `feed_candidates` (0430_posts_rpcs.sql) is what decides this: `friends` takes
 * the posts of the viewer, their friends and the Humans they follow, whatever the audience;
 * `neighborhood` / `city` take posts tagged inside the browsed area whose audience reaches it;
 * `world` takes World-audience posts only.
 */
interface SeededPost {
  readonly author: string
  readonly text: string
}

/** Chris is Ben's friend; the post is Friends-audience, so no wider radius may ever show it. */
const FRIENDS_POST: SeededPost = {
  author: FIXTURE_NAMES.chris,
  text: "Booked the pizza place for Thursday. They do take bookings. I'm as surprised as you.",
}
/**
 * Sarah is Ben's friend and this post is World-audience: Friends shows it because of who wrote
 * it, World because of what she chose. The radius is a browsing context, not an audience (§52).
 */
const FRIEND_WORLD_POST: SeededPost = {
  author: FIXTURE_NAMES.sarah,
  text: 'Made a three-hour walking playlist for the crew. Taking requests for the encore.',
}
/** Maya's Mission moment. She is not Ben's friend, so Friends cannot be where he sees it. */
const NEIGHBORHOOD_POST: SeededPost = {
  author: FIXTURE_NAMES.maya,
  text: "Dolores Park was 40% dogs this afternoon and I'm not complaining.",
}
/** Xavier posts to the city; he is a stranger to Ben, so this is City's alone (and not World's). */
const CITY_POST: SeededPost = {
  author: FIXTURE_NAMES.xavier,
  text: 'Lands End trail is dry again after the rain. Go early, the parking lot fills by 10.',
}
/** Two World posts by Humans Ben is neither friends with nor following. */
const WORLD_POST: SeededPost = {
  author: FIXTURE_NAMES.xavier,
  text: "First fog-free sunrise from Telegraph Hill in weeks. North Beach, you're beautiful.",
}
const WORLD_POST_STRANGER: SeededPost = {
  author: FIXTURE_NAMES.alex,
  text: 'New to Earth. Following a few people from the neighborhood, say hi if you see me around North Beach.',
}

/** `PostCard`'s `<article>` label is `<author>: <first 80 characters of the text>`. */
const POST_LABEL_TEXT_LIMIT = 80

function postArticle(page: Page, post: SeededPost): Locator {
  const name = `${post.author}: ${post.text.slice(0, POST_LABEL_TEXT_LIMIT)}`.trim()
  return page.getByRole('article', { name, exact: true })
}

/** Present means: the card is on screen. */
async function expectPost(page: Page, post: SeededPost): Promise<void> {
  await expect(postArticle(page, post)).toBeVisible()
}

/** Absent means: no card, and the text is not rendered anywhere else on the page either. */
async function expectNoPost(page: Page, post: SeededPost): Promise<void> {
  await expect(postArticle(page, post)).toHaveCount(0)
  await expect(page.getByText(post.text, { exact: true })).toHaveCount(0)
}

/** The one radius control of Home (spec §51, §93). */
function radiusControl(page: Page): Locator {
  return page.getByRole('tablist', { name: webCopy.radiusLabel })
}

/**
 * The page composition of SCREEN 02–05, which a radius change must leave alone: the same
 * document (never a navigation), `/home`, the `earth` wordmark, the four-label radius control,
 * and exactly one selected radius — the one just chosen.
 */
async function expectHomeComposition(page: Page, radius: Radius): Promise<void> {
  expect(new URL(page.url()).pathname).toBe(HOME)
  expect(await documentIsMarked(page)).toBe(true)
  await expect(page.getByRole('heading', { name: APP_NAME, level: 1 })).toBeVisible()

  const control = radiusControl(page)
  await expect(control).toBeVisible()
  for (const key of RADII) {
    await expect(control.getByRole('tab', { name: copy.scopes[key], exact: true })).toBeVisible()
  }
  await expect(control.getByRole('tab', { selected: true })).toHaveCount(1)
  await expect(control.getByRole('tab', { selected: true })).toHaveText(copy.scopes[radius])
}

/**
 * Waits until the whole feed of the current radius is on screen: the end-of-feed line renders
 * only when there are cards and no further page (`FeedList`), which is what makes the absence
 * assertions below mean "not in this radius" rather than "not on the first page".
 */
async function expectWholeFeed(page: Page): Promise<void> {
  await expect(page.getByText(feedCopy.endOfFeed, { exact: true })).toBeVisible()
}

/** Clicks a radius and waits for its feed. Nothing else about the page may change. */
async function switchRadius(page: Page, radius: Radius): Promise<void> {
  await radiusControl(page).getByRole('tab', { name: copy.scopes[radius], exact: true }).click()
  await expectHomeComposition(page, radius)
  await expectWholeFeed(page)
}

/** The context subtitle under the wordmark (SCREEN 03/04); Friends and World have none. */
async function expectSubtitle(page: Page, name: string | null): Promise<void> {
  for (const candidate of [NEIGHBORHOOD_NAME, CITY_NAME]) {
    await expect(page.getByText(candidate, { exact: true })).toHaveCount(candidate === name ? 1 : 0)
  }
}

test('E2E 11 — Radius', async ({ browser }) => {
  const ben = await newPerson(browser)

  try {
    // ------------------------------------------------------------------ Ben, on Home at Friends
    await signInExisting(ben.page, FIXTURE_EMAILS.ben, { next: HOME })
    await markDocument(ben.page)

    // Friends is the member default (spec §51) — the journey never assumes a remembered radius.
    await expectHomeComposition(ben.page, 'friends')
    await expectWholeFeed(ben.page)

    // Friends: a friend's post, and nothing that only a wider radius carries. No subtitle here.
    await expectSubtitle(ben.page, null)
    await expectPost(ben.page, FRIENDS_POST)
    // A friend's World post is here too: Friends is about who wrote it, not what they chose.
    await expectPost(ben.page, FRIEND_WORLD_POST)
    await expectNoPost(ben.page, NEIGHBORHOOD_POST)
    await expectNoPost(ben.page, CITY_POST)
    await expectNoPost(ben.page, WORLD_POST_STRANGER)

    // ------------------------------------------------------------------ Neighborhood — "Mission"
    await switchRadius(ben.page, 'neighborhood')
    await expectSubtitle(ben.page, NEIGHBORHOOD_NAME)
    // The seeded Mission post Friends did not have: its author is a stranger to Ben.
    await expectPost(ben.page, NEIGHBORHOOD_POST)
    await expectNoPost(ben.page, FRIENDS_POST)
    await expectNoPost(ben.page, CITY_POST)

    // ------------------------------------------------------------------ City — "San Francisco"
    await switchRadius(ben.page, 'city')
    await expectSubtitle(ben.page, CITY_NAME)
    await expectPost(ben.page, CITY_POST)
    // The city contains the neighborhood, so the Mission post is here too (spec §52).
    await expectPost(ben.page, NEIGHBORHOOD_POST)
    await expectNoPost(ben.page, FRIENDS_POST)

    // ------------------------------------------------------------------ World — public only
    await switchRadius(ben.page, 'world')
    await expectSubtitle(ben.page, null)
    await expectPost(ben.page, WORLD_POST)
    await expectPost(ben.page, WORLD_POST_STRANGER)
    // The friend's World post is in both radii — the same post, reached two ways.
    await expectPost(ben.page, FRIEND_WORLD_POST)
    // The product fact this journey exists for: a browsing radius never widens an audience.
    await expectNoPost(ben.page, FRIENDS_POST)
    await expectNoPost(ben.page, NEIGHBORHOOD_POST)
    await expectNoPost(ben.page, CITY_POST)

    // ------------------------------------------------------------------ back to Friends
    // Coming back is the same content again: the radius is a browsing context, not a filter that
    // consumed anything (spec §52).
    await switchRadius(ben.page, 'friends')
    await expectSubtitle(ben.page, null)
    await expectPost(ben.page, FRIENDS_POST)
    await expectPost(ben.page, FRIEND_WORLD_POST)
    await expectNoPost(ben.page, NEIGHBORHOOD_POST)
  } finally {
    await closeAll(ben)
  }
})
