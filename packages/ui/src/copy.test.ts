import { describe, expect, it } from 'vitest'

import {
  APP_NAME,
  AUDIENCE_KEYS,
  CONSENT_CHOICES,
  LIVE_JOIN_PROMPT,
  MEDIA_STATE_KEYS,
  NOTIFICATION_TYPE_KEYS,
  OPEN_UP_JOIN_POLICY_OPTIONS,
  OPEN_UP_VISIBILITY_OPTIONS,
  REPORT_REASON_KEYS,
  ROOM_JOIN_POLICY_KEYS,
  ROOM_VISIBILITY_KEYS,
  SCOPE_KEYS,
  TABS,
  copy,
  groupLiveTitle,
  joinPolicyLabels,
  liveTitle,
  renderNotificationCopy,
  reportReasonLabels,
  scopeLabels,
  visibilityLabels,
  type NotificationCopyInput,
} from './copy'
import { mutualLine } from './format'

/** Every string reachable from `copy`, for whole-table assertions. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (typeof value === 'function') {
    // Builders are exercised with representative arguments below.
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) allStrings(child, out)
  }
  return out
}

describe('domain value keys (mirror `@earth/domain` enums in database order)', () => {
  it('lists every enum member in order', () => {
    expect(SCOPE_KEYS).toEqual(['friends', 'neighborhood', 'city', 'world'])
    expect(AUDIENCE_KEYS).toBe(SCOPE_KEYS)
    expect(ROOM_VISIBILITY_KEYS).toEqual([
      'invited',
      'group',
      'friends',
      'extended',
      'neighborhood',
      'city',
      'world',
    ])
    expect(ROOM_JOIN_POLICY_KEYS).toEqual([
      'invited_only',
      'group',
      'friends',
      'friends_of_friends',
      'request',
      'anyone_with_link',
      'anyone',
    ])
    expect(MEDIA_STATE_KEYS).toEqual(['watching', 'audio', 'camera'])
    expect(REPORT_REASON_KEYS).toEqual([
      'harassment',
      'threats',
      'hate',
      'sexual_content',
      'exploitation_minor_safety',
      'impersonation',
      'spam_scam',
      'nonconsensual_imagery',
      'dangerous_location_stalking',
      'violence',
      'other',
    ])
    expect(NOTIFICATION_TYPE_KEYS).toEqual([
      'direct_message',
      'group_message',
      'friend_live',
      'multi_live',
      'group_live',
      'friend_request',
      'friend_accepted',
      'follow',
      'group_invitation',
    ])
  })

  it('label tables cover every key, in the same order, with non-empty labels', () => {
    expect(Object.keys(scopeLabels)).toEqual([...SCOPE_KEYS])
    expect(Object.keys(visibilityLabels)).toEqual([...ROOM_VISIBILITY_KEYS])
    expect(Object.keys(joinPolicyLabels)).toEqual([...ROOM_JOIN_POLICY_KEYS])
    expect(Object.keys(reportReasonLabels)).toEqual([...REPORT_REASON_KEYS])
    for (const label of [
      ...Object.values(scopeLabels),
      ...Object.values(visibilityLabels),
      ...Object.values(joinPolicyLabels),
      ...Object.values(reportReasonLabels),
    ]) {
      expect(label.trim()).toBe(label)
      expect(label.length).toBeGreaterThan(0)
    }
  })
})

describe('notification copy (spec §86)', () => {
  const n = copy.notifications

  it('direct message: name + preview', () => {
    expect(n.directMessage('Xavier', 'see you at 8?')).toEqual({
      title: 'Xavier',
      body: 'see you at 8?',
    })
  })

  it('group message: group + "Name: preview"', () => {
    expect(n.groupMessage('Weekend Crew', 'Maya', 'bringing snacks')).toEqual({
      title: 'Weekend Crew',
      body: 'Maya: bringing snacks',
    })
  })

  it('friend Live: "Xavier is live" + activity, "Join them" without one', () => {
    expect(n.friendLive('Xavier', 'Cooking dinner')).toEqual({
      title: 'Xavier is live',
      body: 'Cooking dinner',
    })
    expect(n.friendLive('Xavier')).toEqual({ title: 'Xavier is live', body: 'Join them' })
    expect(n.friendLive('Xavier', null).body).toBe('Join them')
    expect(n.friendLive('Xavier', '   ').body).toBe('Join them')
    expect(n.friendLive('Xavier', ' Cooking dinner ').body).toBe('Cooking dinner')
    expect(LIVE_JOIN_PROMPT).toBe('Join them')
  })

  it('multi-person Live: "Xavier + Maya are live" + "Join them", always plural', () => {
    expect(n.multiLive(['Xavier', 'Maya'])).toEqual({
      title: 'Xavier + Maya are live',
      body: 'Join them',
    })
    expect(n.multiLive(['Xavier', 'Maya', 'Sam', 'Ben']).title).toBe('Xavier, Maya + 2 are live')
    expect(n.multiLive(['Xavier', 'Maya'], 4).title).toBe('Xavier, Maya + 2 are live')
    // A multi-person Live names at least two people even when only one name is known.
    expect(n.multiLive(['Xavier']).title).toBe('Xavier + 1 are live')
    expect(n.multiLive(['Xavier'], 3).title).toBe('Xavier + 2 are live')
    expect(n.multiLive([], 2).title).toBe('2 people are live')
  })

  it('group Live: "Weekend Crew is live" + "Xavier, Maya + 2"', () => {
    expect(n.groupLive('Weekend Crew', ['Xavier', 'Maya', 'Sam', 'Ben'])).toEqual({
      title: 'Weekend Crew is live',
      body: 'Xavier, Maya + 2',
    })
    expect(n.groupLive('Weekend Crew', ['Xavier', 'Maya'], 4).body).toBe('Xavier, Maya + 2')
    expect(n.groupLive('Weekend Crew', ['Xavier']).body).toBe('Xavier')
    expect(n.groupLive('Weekend Crew', []).body).toBe('')
  })

  it('friend request / accepted / follow / group invitation', () => {
    expect(n.friendRequest('Maya')).toEqual({ title: 'Maya wants to be friends', body: '' })
    expect(n.friendAccepted('Maya')).toEqual({ title: 'You and Maya are friends', body: '' })
    expect(n.follow('Sam')).toEqual({ title: 'Sam followed you', body: '' })
    expect(n.groupInvitation('Xavier', 'Weekend Crew')).toEqual({
      title: 'Xavier brought you into Weekend Crew',
      body: '',
    })
  })

  it('renderNotificationCopy dispatches every notification type', () => {
    const inputs: Record<(typeof NOTIFICATION_TYPE_KEYS)[number], NotificationCopyInput> = {
      direct_message: { type: 'direct_message', senderName: 'Xavier', preview: 'hi' },
      group_message: {
        type: 'group_message',
        groupName: 'Weekend Crew',
        senderName: 'Maya',
        preview: 'hi',
      },
      friend_live: { type: 'friend_live', name: 'Xavier', activity: 'Cooking dinner' },
      multi_live: { type: 'multi_live', names: ['Xavier', 'Maya'] },
      group_live: {
        type: 'group_live',
        groupName: 'Weekend Crew',
        names: ['Xavier', 'Maya'],
        total: 4,
      },
      friend_request: { type: 'friend_request', name: 'Maya' },
      friend_accepted: { type: 'friend_accepted', name: 'Maya' },
      follow: { type: 'follow', name: 'Sam' },
      group_invitation: { type: 'group_invitation', name: 'Xavier', groupName: 'Weekend Crew' },
    }
    const expected: Record<(typeof NOTIFICATION_TYPE_KEYS)[number], string> = {
      direct_message: 'Xavier',
      group_message: 'Weekend Crew',
      friend_live: 'Xavier is live',
      multi_live: 'Xavier + Maya are live',
      group_live: 'Weekend Crew is live',
      friend_request: 'Maya wants to be friends',
      friend_accepted: 'You and Maya are friends',
      follow: 'Sam followed you',
      group_invitation: 'Xavier brought you into Weekend Crew',
    }
    for (const type of NOTIFICATION_TYPE_KEYS) {
      expect(renderNotificationCopy(inputs[type]).title).toBe(expected[type])
    }
  })

  it('SCREEN 23 rows join title and body with an em dash', () => {
    expect(copy.notificationLine(n.friendLive('Xavier', 'Cooking dinner'))).toBe(
      'Xavier is live — Cooking dinner',
    )
    expect(copy.notificationLine(n.groupLive('Weekend Crew', ['Xavier', 'Maya'], 4))).toBe(
      'Weekend Crew is live — Xavier, Maya + 2',
    )
    expect(copy.notificationLine(n.follow('Alex'))).toBe('Alex followed you')
  })
})

describe('claim and gate copy (spec §44–§49)', () => {
  it('is verbatim', () => {
    expect(copy.claimGate).toBe('Earth starts with your people.')
    expect(copy.joinGroup).toBe('Join a group')
    expect(copy.startGroup).toBe('Start a group')
    expect(copy.claimYourPlace).toBe('Claim your place')
    expect(copy.notNow).toBe('Not now')
    expect(copy.claimToJoinConversation).toBe('Claim your place to join the conversation.')
    expect(copy.optionalGroupName).toBe('Optional: Give this group a name')
    expect(copy.skip).toBe('Skip')
    expect(copy.claimToStartGroup).toBe('Claim your place to start the group.')
    expect(copy.proveHuman).toBe("Prove you're human")
    expect(copy.humanExplain).toBe(
      'Earth is one person, one place. Verification is private and is not shown on your profile.',
    )
    expect(copy.youreOnEarth).toBe("You're on Earth.")
    expect(copy.enterGroup('Weekend Crew')).toBe('Enter Weekend Crew')
    expect(copy.bringThemHere).toBe('Bring them here')
    expect(copy.shareLink).toBe('Share link')
    expect(copy.joinThem).toBe('Join them')
    expect(copy.alreadyOnEarth).toBe("Looks like you're already on Earth.")
    expect(copy.recoverMyPlace).toBe('Recover my place')
    expect(copy.thisIsntMe).toBe("This isn't me")
    expect(copy.iNeedHelp).toBe('I need help')
    expect(copy.safetyIssue).toBe('Safety issue')
  })

  it('builds the invite preview title', () => {
    expect(copy.invitePreviewTitle('Weekend Crew', 'Maya, Xavier + 5 others')).toBe(
      'Weekend Crew — Maya, Xavier + 5 others',
    )
    expect(copy.invitePreviewTitle(null, 'Maya, Xavier + 5 others')).toBe('Maya, Xavier + 5 others')
    expect(copy.invitePreviewTitle('  ', 'Maya, Xavier + 5 others')).toBe('Maya, Xavier + 5 others')
    expect(copy.invitePreviewTitle('Weekend Crew', '')).toBe('Weekend Crew')
    expect(copy.invitePreviewTitle(null, '')).toBe('')
  })

  it('never offers the launch-mode escape hatch', () => {
    for (const text of allStrings(copy)) {
      expect(text.toLowerCase()).not.toContain('continue without a group')
    }
  })
})

describe('shell copy (spec §50–§51)', () => {
  it('wordmark is lowercase', () => {
    expect(APP_NAME).toBe('earth')
    expect(copy.wordmark).toBe('earth')
  })

  it('tabs are Home · Chats · Live · Earth · You in order', () => {
    expect(TABS).toEqual(['home', 'chats', 'live', 'earth', 'you'])
    expect(TABS.map((tab) => copy.tabs[tab])).toEqual(['Home', 'Chats', 'Live', 'Earth', 'You'])
    expect(TABS[2]).toBe('live')
  })

  it('scopes are Friends · Neighborhood · City · World for every scope', () => {
    expect(SCOPE_KEYS.map((scope) => scopeLabels[scope])).toEqual([
      'Friends',
      'Neighborhood',
      'City',
      'World',
    ])
    expect(copy.scopes).toBe(scopeLabels)
    expect(copy.audiences).toBe(scopeLabels)
  })
})

describe('home and chats copy (SCREEN 02, 08, 10)', () => {
  it('presence row renders only meaningful state', () => {
    expect(copy.presenceLive(['Xavier', 'Maya'])).toBe('Xavier + Maya live')
    expect(copy.presenceLive(['Xavier'], 3)).toBe('Xavier + 2 live')
    expect(copy.presenceLive([])).toBe('')
    expect(copy.presenceGroupActive('Weekend Crew', 3)).toBe('Weekend Crew · 3 active')
    expect(copy.presenceNearby('Sarah')).toBe('Sarah nearby')
    expect(copy.addPeopleYouKnow).toBe('Add people you actually know')
  })

  it('chat rows match the spec examples verbatim', () => {
    expect(copy.chats).toBe('Chats')
    expect(copy.chatRowLine('College', copy.chatRowLive(['Maya'], 3))).toBe(
      'College — Maya + 2 live',
    )
    expect(copy.chatRowLine('Family', copy.messagePreview('Dad', 'photo'))).toBe(
      'Family — Dad: photo',
    )
    expect(copy.chatRowLine('Saturday', copy.chatRowNearby(4))).toBe('Saturday — 4 nearby')
    expect(copy.chatRowLine('College', copy.chatRowLive([]))).toBe('College')
    expect(copy.chatRowLive([])).toBe('')
    expect(copy.liveJoinLine(3)).toBe('3 live · Join')
    expect(copy.messagePlaceholder).toBe('Message…')
    expect(Object.values(copy.composerActions)).toEqual([
      'Photo/video',
      'File',
      'Poll',
      'Place',
      'Here',
    ])
  })
})

describe('live and room copy (spec §59, §61, SCREEN 13–16)', () => {
  it('titles', () => {
    expect(liveTitle(['Xavier'])).toBe('Xavier is live')
    expect(liveTitle(['Xavier', 'Kavon'])).toBe('Xavier + Kavon are live')
    expect(liveTitle(['Xavier', 'Maya', 'Sam', 'Ben'])).toBe('Xavier, Maya + 2 are live')
    expect(liveTitle(['Xavier'], 3)).toBe('Xavier + 2 are live')
    expect(liveTitle([' Xavier '])).toBe('Xavier is live')
    expect(liveTitle(['Xavier', '  '])).toBe('Xavier is live')
    expect(liveTitle([], 3)).toBe('3 people are live')
    expect(liveTitle([])).toBe('')
    expect(liveTitle(['  '])).toBe('')
    expect(copy.liveTitle).toBe(liveTitle)
    expect(groupLiveTitle('Weekend Crew')).toBe('Weekend Crew is live')
    expect(copy.groupLiveTitle).toBe(groupLiveTitle)
  })

  it('consent copy (SCREEN 16) is verbatim and keyed by room visibility', () => {
    expect(copy.consent('Xavier', 'world')).toBe(
      "Xavier's room is visible to World. If you join on camera, people on Earth may see that you're here.",
    )
    for (const visibility of ROOM_VISIBILITY_KEYS) {
      expect(copy.consent('Maya', visibility)).toContain(
        `visible to ${visibilityLabels[visibility]}.`,
      )
    }
    expect(copy.joinOnCamera).toBe('Join on camera')
    expect(copy.joinAudioOnly).toBe('Join audio only')
    expect(copy.justWatch).toBe('Just watch')
    expect(copy.joinAudio).toBe('Join audio')
    expect(CONSENT_CHOICES.map((c) => c.mediaState)).toEqual(['camera', 'audio', 'watching'])
    expect(CONSENT_CHOICES.map((c) => c.label)).toEqual([
      'Join on camera',
      'Join audio only',
      'Just watch',
    ])
    for (const choice of CONSENT_CHOICES) expect(MEDIA_STATE_KEYS).toContain(choice.mediaState)
  })

  it('open up sheet offers the SCREEN 15 options in order, with labels for every value', () => {
    expect(copy.openUp).toBe('Open up')
    expect(copy.whoCanJoin).toBe('Who can join')
    expect(OPEN_UP_VISIBILITY_OPTIONS.map((v) => visibilityLabels[v])).toEqual([
      'Just us',
      'Group',
      'Friends',
      'Neighborhood',
      'City',
      'World',
    ])
    expect(OPEN_UP_JOIN_POLICY_OPTIONS.map((p) => joinPolicyLabels[p])).toEqual([
      'Invite only',
      'Group',
      'Friends',
      'Request',
      'Anyone eligible',
    ])
    // Sheet order is the narrow → wide enum order with the unoffered values removed.
    const offeredVisibility: ReadonlySet<string> = new Set(OPEN_UP_VISIBILITY_OPTIONS)
    const offeredPolicies: ReadonlySet<string> = new Set(OPEN_UP_JOIN_POLICY_OPTIONS)
    expect(ROOM_VISIBILITY_KEYS.filter((v) => offeredVisibility.has(v))).toEqual([
      ...OPEN_UP_VISIBILITY_OPTIONS,
    ])
    expect(ROOM_JOIN_POLICY_KEYS.filter((p) => offeredPolicies.has(p))).toEqual([
      ...OPEN_UP_JOIN_POLICY_OPTIONS,
    ])
    expect(copy.visibility).toBe(visibilityLabels)
    expect(copy.joinPolicies).toBe(joinPolicyLabels)
    expect(copy.keepingRoomOpen).toBe("You're keeping the room open.")
    expect(Object.values(copy.roomControls)).toEqual([
      'Microphone',
      'Camera',
      'Flip camera',
      'Participants',
      'More',
      'Leave',
    ])
  })
})

describe('guest copy (SCREEN 17–19)', () => {
  it('is verbatim', () => {
    expect(copy.joinAsGuest).toBe('Join as Guest')
    expect(copy.yourName).toBe('Your name')
    expect(copy.join).toBe('Join')
    expect(copy.openInEarth).toBe('Open in Earth')
    expect(copy.guest).toBe('Guest')
    expect(copy.guestPostRoom).toBe(
      'Good hanging out. Claim your place if you want to stay connected on Earth.',
    )
    expect(copy.claimMyPlace).toBe('Claim my place')
    expect(copy.done).toBe('Done')
    expect(copy.guestRepeat(3, 11)).toBe("You've joined 3 Earth rooms with 11 people you know.")
    expect(copy.guestRepeat(1, 1)).toBe("You've joined 1 Earth room with 1 person you know.")
  })
})

describe('failure, verification, location, search and profile copy', () => {
  it('PART XX failure states are verbatim', () => {
    expect(copy.waitingForConnection).toBe('Waiting for connection')
    expect(copy.connectionUnavailable).toBe('Connection unavailable')
    expect(copy.tapToRetry).toBe('Tap to retry')
    expect(copy.reconnecting).toBe('Reconnecting…')
    expect(copy.reconnecting.endsWith('…')).toBe(true)
    expect(copy.couldntReconnect).toBe("Couldn't reconnect")
    expect(copy.tryAgain).toBe('Try again')
    expect(copy.leave).toBe('Leave')
    expect(copy.couldntRefresh).toBe("Couldn't refresh")
    expect(copy.getHelpVerifying).toBe('Get help verifying')
    expect(copy.recoverYourPlace).toBe('Recover your place')
  })

  it('§75 / §78 copy is verbatim', () => {
    expect(copy.verificationPrivacy).toBe(
      'Earth verifies that one real person is claiming one place. Your verification details are private.',
    )
    expect(copy.shareWith('Weekend Crew')).toBe('Share with Weekend Crew')
    expect(Object.values(copy.durations)).toEqual(['1 hour', 'Tonight', 'Custom'])
  })

  it('SCREEN 06 / 21 / 22 / 24 copy', () => {
    expect(copy.post).toBe('Post')
    expect(Object.values(copy.searchSections)).toEqual(['People', 'Groups', 'Places', 'Posts'])
    expect(copy.searchPersonLine('Xavier', mutualLine(8, 'San Francisco'))).toBe(
      'Xavier — 8 mutual friends · San Francisco',
    )
    expect(copy.searchPersonLine('Xavier', mutualLine(0, null))).toBe('Xavier')
    expect(copy.profileActions).toEqual({
      addFriend: 'Add Friend',
      friends: 'Friends',
      follow: 'Follow',
      following: 'Following',
      message: 'Message',
      more: 'More',
    })
    expect(copy.notificationsTitle).toBe('Notifications')
    expect(copy.yourEarth).toBe('Your Earth')
  })

  it('never uses the forbidden generic verification failure', () => {
    for (const text of allStrings(copy)) {
      expect(text.toLowerCase()).not.toContain('verification failed')
    }
  })

  it('uses straight apostrophes and no stray whitespace, like the spec', () => {
    for (const text of allStrings(copy)) {
      expect(text).not.toMatch(/[‘’“”]/)
      expect(text.trim()).toBe(text)
      expect(text).not.toMatch(/ {2}/)
    }
  })
})

describe('safety copy (§81–§82)', () => {
  it('report reasons are exact and cover every reason in spec order', () => {
    expect(REPORT_REASON_KEYS.map((reason) => reportReasonLabels[reason])).toEqual([
      'Harassment',
      'Threats',
      'Hate',
      'Sexual content',
      'Exploitation/minor safety',
      'Impersonation',
      'Spam/scam',
      'Nonconsensual imagery',
      'Dangerous location/stalking behavior',
      'Violence',
      'Other',
    ])
    expect(copy.reportReasons).toBe(reportReasonLabels)
  })

  it('mandatory controls are present', () => {
    expect(copy.safety).toEqual({
      block: 'Block',
      unblock: 'Unblock',
      report: 'Report',
      hide: 'Hide',
      blockAuthor: 'Block author',
      leave: 'Leave',
      remove: 'Remove',
      disableGuests: 'Disable Guests',
      changeJoinPolicy: 'Change join policy',
      endRoom: 'End room',
    })
  })

  it('settings sections follow SCREEN 25', () => {
    expect(copy.settings.title).toBe('Settings')
    expect(Object.values(copy.settings.sections).map((s) => s.title)).toEqual([
      'Account',
      'Privacy',
      'Notifications',
      'Safety',
      'Human identity',
    ])
    expect(Object.values(copy.settings.sections.humanIdentity.items)).toEqual([
      'Human Pass status',
      'Recovery and help',
    ])
  })
})
