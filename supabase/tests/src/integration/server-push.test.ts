/**
 * `POST /api/internal/push/dispatch` end to end (ARCHITECTURE §6, §11; spec §12, §86; DB_API §6):
 * `message_send` creates the notification rows, `notifications_unsent` hands them to the dispatcher
 * with the recipients' tokens, the dispatcher builds one Expo message per device with the exact
 * spec copy, `notifications_mark_pushed` stamps `push_sent_at`, and a recipient who is looking at
 * that very conversation is never pushed.
 */
import { notificationCopy } from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PUSH_CHANNELS, type PushDispatchOutcome } from '../../../../packages/server/src/index'
import { createTestDb, type TestDb } from '../harness'
import {
  addMember,
  createGroup,
  createHuman,
  directConversation,
  pushSentAt,
  registerPushToken,
  scalar,
  sendMessage,
  setPresence,
  unsent,
  type GroupFixture,
  type Human,
  type UnsentRow,
} from '../notifications/fixtures'
import {
  createEarthServer,
  createServerTestDeps,
  errorCodeOf,
  fakeRequest,
  type EarthServer,
  type ServerTestDeps,
} from './server-deps'

describe('POST /api/internal/push/dispatch (server tier ↔ notification RPCs)', () => {
  let db: TestDb
  let ctx: ServerTestDeps
  let server: EarthServer
  let alice: Human
  let bob: Human
  let carol: Human
  let dave: Human
  let group: GroupFixture
  let convBob: string
  let convCarol: string
  let convDave: string

  async function dispatch(headers: Record<string, string> = ctx.cronHeaders()) {
    return server.handle(
      fakeRequest({ method: 'POST', url: '/api/internal/push/dispatch', headers }),
    )
  }

  async function notificationId(objectId: string, recipient: Human): Promise<string> {
    return scalar<string>(
      db,
      'id from public.notifications where object_id = $1 and recipient_human_id = $2',
      [objectId, recipient.humanId],
    )
  }

  beforeAll(async () => {
    db = await createTestDb()
    ctx = createServerTestDeps(db)
    server = createEarthServer(ctx.deps)
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
    dave = await createHuman(db, { handle: 'dave', displayName: 'Dave' })
    await registerPushToken(db, bob, 'ExponentPushToken[bob-ios]', 'ios')
    await registerPushToken(db, bob, 'ExponentPushToken[bob-android]', 'android')
    await registerPushToken(db, carol, 'ExponentPushToken[carol-web]', 'web')
    group = await createGroup(db, alice, 'Weekend Crew')
    await addMember(db, group, bob)
    convBob = await directConversation(db, alice, bob)
    convCarol = await directConversation(db, alice, carol)
    convDave = await directConversation(db, alice, dave)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('is cron-protected', async () => {
    const missing = await dispatch({})
    expect(missing.status).toBe(401)
    expect(errorCodeOf(missing)).toBe('not_authenticated')
    const wrong = await dispatch({ 'x-earth-cron-secret': 'nope' })
    expect(wrong.status).toBe(403)
    expect(errorCodeOf(wrong)).toBe('forbidden')
    expect(ctx.calls).toHaveLength(0)
  })

  it('sends the spec copy to every device, marks the rows pushed and skips the recipient in the conversation', async () => {
    const dm = await sendMessage(db, alice, convBob, 'hey bob')
    const gm = await sendMessage(db, alice, group.conversationId, 'hello crew')
    const toCarol = await sendMessage(db, alice, convCarol, 'carol is reading this')
    const toDave = await sendMessage(db, alice, convDave, 'dave has no device')
    await setPresence(db, carol, {
      lastActiveAt: new Date(),
      activeConversationId: convCarol,
      platform: 'web',
    })

    const res = await dispatch()
    expect(res.status).toBe(200)
    const outcome = res.body as PushDispatchOutcome
    expect(outcome).toMatchObject({
      ok: true,
      ranAt: ctx.clock.now.toISOString(),
      fetched: 3,
      recipients: 2,
      sent: 4,
      suppressed: 0,
      skipped: 1,
      failed: 0,
      deferred: 0,
      marked: 3,
    })

    // notifications_unsent handed the dispatcher the rows with the recipients' tokens (as the service).
    const fetched = ctx.callsTo('notifications_unsent')
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toMatchObject({ client: 'admin', as: 'service' })
    const rows = fetched[0]?.data as UnsentRow[]
    const dmId = await notificationId(dm, bob)
    const gmId = await notificationId(gm, bob)
    const daveId = await notificationId(toDave, dave)
    const carolId = await notificationId(toCarol, carol)
    expect(rows.map((row) => row.id).sort()).toEqual([dmId, gmId, daveId].sort())
    expect(rows.find((row) => row.id === dmId)).toMatchObject({
      recipientHumanId: bob.humanId,
      type: 'direct_message',
      objectType: 'message',
      objectId: dm,
      payload: { senderName: 'Alice', preview: 'hey bob', conversationId: convBob },
      pushTokens: [
        { token: 'ExponentPushToken[bob-ios]', platform: 'ios' },
        { token: 'ExponentPushToken[bob-android]', platform: 'android' },
      ],
    })
    expect(rows.find((row) => row.id === daveId)?.pushTokens).toEqual([])

    // One Expo message per device with the exact spec §86 copy.
    expect(ctx.push.messages).toHaveLength(4)
    const dmCopy = notificationCopy({
      type: 'direct_message',
      senderName: 'Alice',
      preview: 'hey bob',
    })
    expect(dmCopy).toEqual({ title: 'Alice', body: 'hey bob' })
    const dmMessages = ctx.push.messages.filter(
      (message) => message.data['notificationId'] === dmId,
    )
    expect(dmMessages.map((message) => message.to).sort()).toEqual([
      'ExponentPushToken[bob-android]',
      'ExponentPushToken[bob-ios]',
    ])
    for (const message of dmMessages) {
      expect(message).toEqual({
        to: message.to,
        title: dmCopy.title,
        body: dmCopy.body,
        data: {
          notificationId: dmId,
          type: 'direct_message',
          objectType: 'message',
          objectId: dm,
          conversationId: convBob,
        },
        priority: 'high',
        sound: 'default',
        channelId: PUSH_CHANNELS.messages,
      })
    }
    const gmCopy = notificationCopy({
      type: 'group_message',
      groupName: 'Weekend Crew',
      senderName: 'Alice',
      preview: 'hello crew',
    })
    expect(gmCopy).toEqual({ title: 'Weekend Crew', body: 'Alice: hello crew' })
    const gmMessages = ctx.push.messages.filter(
      (message) => message.data['notificationId'] === gmId,
    )
    expect(gmMessages).toHaveLength(2)
    for (const message of gmMessages) {
      expect(message).toMatchObject({
        title: gmCopy.title,
        body: gmCopy.body,
        data: {
          notificationId: gmId,
          type: 'group_message',
          objectId: gm,
          conversationId: group.conversationId,
        },
        channelId: PUSH_CHANNELS.messages,
      })
    }
    expect(ctx.push.messages.some((message) => message.to === 'ExponentPushToken[carol-web]')).toBe(
      false,
    )

    // Every handled row carries push_sent_at: pushed, deviceless, and suppressed by presence.
    expect(ctx.callsTo('notifications_mark_pushed').at(-1)).toMatchObject({
      client: 'admin',
      as: 'service',
    })
    expect(
      (ctx.callsTo('notifications_mark_pushed').at(-1)?.args['ids'] as string[]).sort(),
    ).toEqual([dmId, gmId, daveId].sort())
    for (const id of [dmId, gmId, daveId, carolId]) expect(await pushSentAt(db, id)).not.toBeNull()
    expect(await unsent(db)).toEqual([])

    // A second run has nothing to do.
    const again = (await dispatch()).body as PushDispatchOutcome
    expect(again).toMatchObject({ fetched: 0, sent: 0, marked: 0 })
    expect(ctx.push.messages).toHaveLength(4)
  })
})
