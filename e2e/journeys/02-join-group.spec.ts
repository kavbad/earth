/**
 * E2E 2 — Join group (spec §116): New Visitor → group invite → verify → chat.
 *
 * A starts a group and shares its link the way the product offers it ("Bring them here" →
 * "Share link", spec §45 step 10). B, a Visitor with an empty browser, opens that link, reads a
 * preview that names the group and A, taps "Join them" and claims a place with intent
 * `join_group`. After "You're on Earth." the CTA opens the group's conversation directly — spec
 * §46 step 8: the group, never a generic Home.
 *
 * What the journey proves afterwards is membership, not friendship (spec §21, §46): B is in the
 * group (A's thread carries the "<name> joined" system line, group info lists both), and joining
 * a group made nobody friends — A's profile still offers B "Add Friend".
 */
import { expect, test } from '@playwright/test'

import { expectToast } from '../fixtures/assertions'
import { MEDIA_PERMISSIONS, closeAll, newPerson } from '../fixtures/contexts'
import { chatCopy, copy, participantSummary, webCopy } from '../fixtures/copy'
import { createHumanViaClaim, finishClaim, uniqueEmail, uniqueName } from '../fixtures/people'

const CONVERSATION_URL = /\/chats\/[0-9a-f-]{36}$/
const CONVERSATION_INFO_URL = /\/chats\/[0-9a-f-]{36}\/info$/
const INVITE_LINK = /\/g\/[A-Za-z0-9_-]+$/
/** Where the claim must never detour through (spec §46 step 8, §49). */
const HOME_PATH = '/home'
/** The membership gate an invited person skips: the link already chose the group (spec §46). */
const GATE_PATH = '/claim'

test('E2E 2 — Join group', async ({ browser }) => {
  // A copies the invite link to the clipboard, which is a permission like any other.
  const a = await newPerson(browser, {
    permissions: [...MEDIA_PERMISSIONS, 'clipboard-read', 'clipboard-write'],
  })
  const b = await newPerson(browser)

  const groupName = uniqueName('Crew')
  const nameA = uniqueName('Ada')
  const nameB = uniqueName('Bo')

  // Every page B lands on, so "the chat opens directly" can be asserted and not assumed.
  const visited: string[] = []
  b.page.on('framenavigated', (frame) => {
    if (frame === b.page.mainFrame()) visited.push(new URL(frame.url()).pathname)
  })

  try {
    // ---------------------------------------------------------------- A starts a group
    const humanA = await createHumanViaClaim(a.page, {
      email: uniqueEmail('a'),
      displayName: nameA,
      intent: 'start_group',
      groupName,
    })

    // ---------------------------------------------------------------- A copies the invite link
    await a.page.getByRole('link', { name: `${groupName} · ${chatCopy.openInfo}` }).click()
    await a.page.waitForURL(CONVERSATION_INFO_URL)
    await expect(a.page.getByText(copy.bringThemHere, { exact: true })).toBeVisible()
    await a.page.getByRole('button', { name: copy.shareLink }).click()
    await expectToast(a.page, chatCopy.linkCopied)

    const linkButton = a.page.getByRole('button', { name: INVITE_LINK })
    await expect(linkButton).toBeVisible()
    const inviteUrl = ((await linkButton.textContent()) ?? '').trim()
    expect(inviteUrl).toMatch(INVITE_LINK)
    // What was offered on screen is what was put on the clipboard.
    await expect(a.page.evaluate(() => navigator.clipboard.readText())).resolves.toBe(inviteUrl)

    // ---------------------------------------------------------------- B previews the invite
    await b.page.goto(inviteUrl)
    await expect(
      b.page.getByRole('heading', {
        name: copy.invitePreviewTitle(groupName, participantSummary([nameA], 1)),
      }),
    ).toBeVisible()
    await expect(b.page.getByText(webCopy.inviteMembers(1), { exact: true })).toBeVisible()

    // ---------------------------------------------------------------- B joins them and claims
    await b.page.getByRole('button', { name: copy.joinThem }).click()
    // Spec §46: "Join them" hands the invite to the claim flow — intent `join_group`.
    await b.page.waitForURL(/\/claim\/credential$/)

    const humanB = await finishClaim(b.page, {
      email: uniqueEmail('b'),
      displayName: nameB,
      groupName,
    })

    // The claim landed in A's group's conversation, with no Home in between: every page B saw is
    // in `visited` (the claim's own screens prove the recorder was listening).
    expect(humanB.conversationId).toBe(humanA.conversationId)
    expect(visited).toContain('/claim/credential')
    expect(visited).toContain('/welcome')
    expect(visited.filter((path) => path === HOME_PATH)).toEqual([])
    // The invite carried the group, so B never met the membership gate's choice (spec §46).
    expect(visited).not.toContain(GATE_PATH)
    await expect(b.page).toHaveURL(CONVERSATION_URL)
    await expect(
      b.page.getByRole('link', { name: `${groupName} · ${chatCopy.openInfo}` }),
    ).toBeVisible()
    await expect(b.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()

    // ---------------------------------------------------------------- A sees B arrive
    // The system line of DB_API §2 `group_invite_join`, delivered to the thread A already has open.
    await a.page.goBack()
    await a.page.waitForURL(CONVERSATION_URL)
    await expect(a.page.getByText(`${nameB} joined`, { exact: true })).toBeVisible()

    // ---------------------------------------------------------------- B is a member, not a friend
    await b.page.getByRole('link', { name: `${groupName} · ${chatCopy.openInfo}` }).click()
    await b.page.waitForURL(CONVERSATION_INFO_URL)
    await expect(b.page.getByRole('heading', { name: copy.groupInfo.members })).toBeVisible()
    await expect(b.page.getByText(webCopy.inviteMembers(2), { exact: true })).toBeVisible()

    const memberA = b.page.getByRole('button', { name: nameA })
    const memberB = b.page.getByRole('button', { name: nameB })
    await expect(memberA).toBeVisible()
    await expect(memberA).toContainText(chatCopy.owner)
    await expect(memberB).toBeVisible()
    await expect(memberB).toContainText(chatCopy.you)
    // Membership is not friendship: the member row would say so (spec §21).
    await expect(memberA).not.toContainText(chatCopy.friend)

    await memberA.click()
    await b.page.getByRole('link', { name: chatCopy.viewProfile }).click()
    await b.page.waitForURL(new RegExp(`/@${humanA.handle}$`))
    await expect(b.page.getByRole('heading', { name: nameA, exact: true }).first()).toBeVisible()
    await expect(
      b.page.getByRole('button', { name: copy.profileActions.addFriend, exact: true }),
    ).toBeVisible()
    await expect(
      b.page.getByRole('button', { name: copy.profileActions.friends, exact: true }),
    ).toHaveCount(0)
  } finally {
    await closeAll(a, b)
  }
})
