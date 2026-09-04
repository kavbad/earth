import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '../storage'
import {
  DEFAULT_AUDIENCE,
  DEFAULT_NOTIFICATION_PREFS,
  LIVE_DEFAULTS_FALLBACK,
  LIVE_JOIN_POLICY_CHOICES,
  LIVE_VISIBILITY_CHOICES,
  notificationPrefsReducer,
  parseNotificationPrefs,
  prefKey,
  pushPermissionAction,
  pushPermissionState,
  readDefaultAudience,
  readLiveDefaults,
  readNotificationPrefs,
  writeDefaultAudience,
  writeLiveDefaults,
  writeNotificationPrefs,
} from './prefs'

const HUMAN = '11111111-1111-4111-8111-111111111111'

describe('device preferences (SCREEN 25 Privacy)', () => {
  it('defaults the post audience to Friends and remembers a change per Human', async () => {
    const storage = createMemoryStorage()
    expect(await readDefaultAudience(storage, HUMAN)).toBe(DEFAULT_AUDIENCE)
    await writeDefaultAudience(storage, HUMAN, 'city')
    expect(await readDefaultAudience(storage, HUMAN)).toBe('city')
    expect(await readDefaultAudience(storage, 'someone-else')).toBe('friends')
    expect(storage.values.get(prefKey(HUMAN, 'defaultAudience'))).toBe('city')
  })

  it('ignores values that are not audiences', async () => {
    const storage = createMemoryStorage({ [prefKey(HUMAN, 'defaultAudience')]: 'everyone' })
    expect(await readDefaultAudience(storage, HUMAN)).toBe('friends')
    expect(await readDefaultAudience(null, HUMAN)).toBe('friends')
  })

  it('keeps Live defaults within the Open up choices and falls back to friends / friends', async () => {
    const storage = createMemoryStorage()
    expect(await readLiveDefaults(storage, HUMAN)).toEqual(LIVE_DEFAULTS_FALLBACK)
    await writeLiveDefaults(storage, HUMAN, { visibility: 'city', joinPolicy: 'request' })
    expect(await readLiveDefaults(storage, HUMAN)).toEqual({
      visibility: 'city',
      joinPolicy: 'request',
    })
    await writeLiveDefaults(storage, HUMAN, { visibility: 'group', joinPolicy: 'group' })
    expect(await readLiveDefaults(storage, HUMAN)).toEqual(LIVE_DEFAULTS_FALLBACK)
    expect(LIVE_VISIBILITY_CHOICES).not.toContain('group')
    expect(LIVE_JOIN_POLICY_CHOICES).not.toContain('group')
  })
})

describe('notification categories (SCREEN 25 Notifications, spec §86)', () => {
  it('toggles and sets one category at a time', () => {
    let prefs = DEFAULT_NOTIFICATION_PREFS
    prefs = notificationPrefsReducer(prefs, { type: 'toggle', category: 'engagement' })
    expect(prefs.engagement).toBe(false)
    expect(prefs.messages).toBe(true)
    const same = notificationPrefsReducer(prefs, { type: 'set', category: 'live', enabled: true })
    expect(same).toBe(prefs)
    prefs = notificationPrefsReducer(prefs, { type: 'set', category: 'live', enabled: false })
    expect(prefs.live).toBe(false)
    prefs = notificationPrefsReducer(prefs, { type: 'replace', prefs: DEFAULT_NOTIFICATION_PREFS })
    expect(prefs).toEqual(DEFAULT_NOTIFICATION_PREFS)
  })

  it('reads partial or malformed storage safely', async () => {
    expect(parseNotificationPrefs({ live: false })).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      live: false,
    })
    expect(parseNotificationPrefs({ live: 'no' })).toEqual(DEFAULT_NOTIFICATION_PREFS)
    expect(parseNotificationPrefs('nope')).toEqual(DEFAULT_NOTIFICATION_PREFS)
    const storage = createMemoryStorage()
    await writeNotificationPrefs(storage, HUMAN, { ...DEFAULT_NOTIFICATION_PREFS, social: false })
    expect(await readNotificationPrefs(storage, HUMAN)).toMatchObject({
      social: false,
      messages: true,
    })
    expect(await readNotificationPrefs(null, HUMAN)).toEqual(DEFAULT_NOTIFICATION_PREFS)
  })

  it('reads the push permission into what the row offers', () => {
    expect(pushPermissionState(null)).toBe('unknown')
    expect(pushPermissionState({ status: 'granted', granted: true })).toBe('granted')
    expect(pushPermissionState({ status: 'undetermined', granted: false })).toBe('undetermined')
    expect(pushPermissionState({ status: 'denied', granted: false, canAskAgain: true })).toBe(
      'denied',
    )
    expect(pushPermissionState({ status: 'denied', granted: false, canAskAgain: false })).toBe(
      'blocked',
    )
    expect(pushPermissionAction('undetermined')).toBe('ask')
    expect(pushPermissionAction('blocked')).toBe('settings')
    expect(pushPermissionAction('granted')).toBe('none')
  })
})
