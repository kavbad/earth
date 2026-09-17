/**
 * Canonical microcopy (ARCHITECTURE §13). Every string the spec quotes is here verbatim and is
 * used unchanged by both clients.
 *
 * `@earth/ui` is a leaf package: it imports no other workspace package. Tables keyed by domain
 * values are typed against the `*_KEYS` lists below, which mirror the `@earth/domain` enums in
 * the database's order. A consumer that indexes a table with a domain value gets a compile error
 * the moment the two lists diverge, and `copy.test.ts` pins every list against the spec.
 *
 * Sources: EARTH_V1_SPEC.md PART IV (§44–§49), PART V (§50–§51), PART VI (screens), §59, §61,
 * §75, §78–§79, §81–§82, PART XIV (§86), PART XX (§107–§111).
 */
import { cleanNames, joinWithDash, namesWithPlus, pluralize } from './format'

/** The product wordmark. Rendered lowercase everywhere (SCREEN 01/02 header `earth`). */
export const APP_NAME = 'earth' as const

/** Bottom navigation destinations (spec §50), in order. */
export const TABS = ['home', 'chats', 'live', 'earth', 'you'] as const
export type Tab = (typeof TABS)[number]

// ---------------------------------------------------------------------------
// Domain value keys (mirrors of `@earth/domain` enums, in the database's order)
// ---------------------------------------------------------------------------

/** Browsing radius (spec §51–§52) — `Scope` in `@earth/domain`, in display order. */
export const SCOPE_KEYS = ['friends', 'neighborhood', 'city', 'world'] as const
export type ScopeKey = (typeof SCOPE_KEYS)[number]

/** Post audiences (SCREEN 06) are the same four values — `Audience` in `@earth/domain`. */
export const AUDIENCE_KEYS = SCOPE_KEYS
export type AudienceKey = ScopeKey

/** `RoomVisibility`, ordered narrow → wide (ARCHITECTURE §10). */
export const ROOM_VISIBILITY_KEYS = [
  'invited',
  'group',
  'friends',
  'extended',
  'neighborhood',
  'city',
  'world',
] as const
export type RoomVisibilityKey = (typeof ROOM_VISIBILITY_KEYS)[number]

/** `RoomJoinPolicy` (spec §32). */
export const ROOM_JOIN_POLICY_KEYS = [
  'invited_only',
  'group',
  'friends',
  'friends_of_friends',
  'request',
  'anyone_with_link',
  'anyone',
] as const
export type RoomJoinPolicyKey = (typeof ROOM_JOIN_POLICY_KEYS)[number]

/** `MediaState` (spec §33). */
export const MEDIA_STATE_KEYS = ['watching', 'audio', 'camera'] as const
export type MediaStateKey = (typeof MEDIA_STATE_KEYS)[number]

/** `ReportReason` (spec §82), snake_cased in the spec's order. */
export const REPORT_REASON_KEYS = [
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
] as const
export type ReportReasonKey = (typeof REPORT_REASON_KEYS)[number]

/** `NotificationType` — the exact V1 notification types (spec §86), in the spec's order. */
export const NOTIFICATION_TYPE_KEYS = [
  'direct_message',
  'group_message',
  'friend_live',
  'multi_live',
  'group_live',
  'friend_request',
  'friend_accepted',
  'follow',
  'group_invitation',
] as const
export type NotificationTypeKey = (typeof NOTIFICATION_TYPE_KEYS)[number]

// ---------------------------------------------------------------------------
// Label tables
// ---------------------------------------------------------------------------

/** Rendered title + body of a notification (spec §86). `body` may be empty. */
export interface NotificationCopy {
  readonly title: string
  readonly body: string
}

export const scopeLabels = {
  friends: 'Friends',
  neighborhood: 'Neighborhood',
  city: 'City',
  world: 'World',
} as const satisfies Record<ScopeKey, string>

/** Post audiences (SCREEN 06) share the radius labels; the values are identical. */
export const audienceLabels = scopeLabels satisfies Record<AudienceKey, string>

/**
 * Room visibility (SCREEN 15). `extended` is not offered by the Open up sheet in V1; its label
 * exists so every enum value renders.
 */
export const visibilityLabels = {
  invited: 'Just us',
  group: 'Group',
  friends: 'Friends',
  extended: 'Friends of friends',
  neighborhood: 'Neighborhood',
  city: 'City',
  world: 'World',
} as const satisfies Record<RoomVisibilityKey, string>

/**
 * "Who can join" (SCREEN 15). `friends_of_friends` and `anyone_with_link` are not offered by the
 * sheet in V1; their labels exist so every enum value renders.
 */
export const joinPolicyLabels = {
  invited_only: 'Invite only',
  group: 'Group',
  friends: 'Friends',
  friends_of_friends: 'Friends of friends',
  request: 'Request',
  anyone_with_link: 'Anyone with the link',
  anyone: 'Anyone eligible',
} as const satisfies Record<RoomJoinPolicyKey, string>

/**
 * SCREEN 15 visibility choices in the sheet's order: Just us / Group, Friends, Neighborhood,
 * City, World. Context narrows this further (`group` only for group rooms, `invited` otherwise).
 */
export const OPEN_UP_VISIBILITY_OPTIONS = [
  'invited',
  'group',
  'friends',
  'neighborhood',
  'city',
  'world',
] as const satisfies readonly RoomVisibilityKey[]

/** SCREEN 15 "Who can join" choices in the sheet's order. */
export const OPEN_UP_JOIN_POLICY_OPTIONS = [
  'invited_only',
  'group',
  'friends',
  'request',
  'anyone',
] as const satisfies readonly RoomJoinPolicyKey[]

/** Spec §82, exact labels in the spec's order. */
export const reportReasonLabels = {
  harassment: 'Harassment',
  threats: 'Threats',
  hate: 'Hate',
  sexual_content: 'Sexual content',
  exploitation_minor_safety: 'Exploitation/minor safety',
  impersonation: 'Impersonation',
  spam_scam: 'Spam/scam',
  nonconsensual_imagery: 'Nonconsensual imagery',
  dangerous_location_stalking: 'Dangerous location/stalking behavior',
  violence: 'Violence',
  other: 'Other',
} as const satisfies Record<ReportReasonKey, string>

// ---------------------------------------------------------------------------
// Live titles (spec §59, §86) — same rules as `@earth/domain`'s `liveTitle`
// ---------------------------------------------------------------------------

/** Body / CTA inviting the viewer into a Live (spec §59, §86, SCREEN 14). */
export const LIVE_JOIN_PROMPT = 'Join them' as const

/**
 * `Xavier is live` · `Xavier + Kavon are live` · `Xavier, Maya + 2 are live`. Empty string when
 * nobody is live. `total` is the number of people when `names` is only a sample.
 */
export function liveTitle(names: readonly string[], total?: number): string {
  const subject = namesWithPlus(names, total === undefined ? {} : { total })
  if (subject.length === 0) return ''
  const named = cleanNames(names).length
  const count = Math.max(total ?? named, named)
  return count === 1 ? `${subject} is live` : `${subject} are live`
}

/** `Weekend Crew is live` (ARCHITECTURE §9, spec §86 group Live title). */
export function groupLiveTitle(groupName: string): string {
  return `${groupName} is live`
}

/** `Xavier + Maya live` (presence row) · `Maya + 2 live` (chat row). Empty when nobody is live. */
function namesLive(names: readonly string[], total?: number): string {
  const subject = namesWithPlus(names, total === undefined ? {} : { total })
  return subject.length === 0 ? '' : `${subject} live`
}

function activityOrPrompt(activity: string | null | undefined): string {
  const trimmed = activity?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : LIVE_JOIN_PROMPT
}

export const copy = {
  wordmark: APP_NAME,

  // ------------------------------------------------------------------ §44 membership gate
  claimGate: 'Earth starts with your people.',
  joinGroup: 'Join a group',
  startGroup: 'Start a group',
  claimYourPlace: 'Claim your place',
  notNow: 'Not now',
  /** SCREEN 01 visitor bottom sheet. */
  claimToJoinConversation: 'Claim your place to join the conversation.',

  // ------------------------------------------------------------------ §45 start-group flow
  optionalGroupName: 'Optional: Give this group a name',
  skip: 'Skip',
  claimToStartGroup: 'Claim your place to start the group.',
  displayName: 'Display name',
  handle: 'Handle',
  profilePhoto: 'Profile photo',
  proveHuman: "Prove you're human",
  humanExplain:
    'Earth is one person, one place. Verification is private and is not shown on your profile.',
  youreOnEarth: "You're on Earth.",
  /** §49 primary CTA: `Enter Weekend Crew`. */
  enterGroup: (groupName: string): string => `Enter ${groupName}`,
  /** §45 step 10: prominent `Bring them here` — `Share link`. */
  bringThemHere: 'Bring them here',
  shareLink: 'Share link',

  // ------------------------------------------------------------------ §46 join-group flow
  /** `Weekend Crew — Maya, Xavier + 5 others`; participants only when the group has no name. */
  invitePreviewTitle: (groupName: string | null, participants: string): string =>
    joinWithDash(groupName ?? '', participants),
  joinThem: LIVE_JOIN_PROMPT,

  // ------------------------------------------------------------------ §48 duplicate Human
  alreadyOnEarth: "Looks like you're already on Earth.",
  recoverMyPlace: 'Recover my place',
  thisIsntMe: "This isn't me",
  iNeedHelp: 'I need help',
  safetyIssue: 'Safety issue',

  // ------------------------------------------------------------------ §50–§51 shell
  tabs: {
    home: 'Home',
    chats: 'Chats',
    live: 'Live',
    earth: 'Earth',
    you: 'You',
  } as const satisfies Record<Tab, string>,
  scopes: scopeLabels,
  audiences: audienceLabels,

  // ------------------------------------------------------------------ SCREEN 02–05 Home
  addPeopleYouKnow: 'Add people you actually know',
  // The server labels the presence row it sends with the same three strings, built by
  // `presenceLiveLabel` / `presenceGroupActiveLabel` / `presenceNearbyLabel` in
  // `packages/domain/src/feed/presence.ts`; both sides pin the spec's examples.
  /** Presence row: `Xavier + Maya live`. Rendered only with meaningful state (empty otherwise). */
  presenceLive: (names: readonly string[], total?: number): string => namesLive(names, total),
  /** Presence row: `Weekend Crew · 3 active`. */
  presenceGroupActive: (groupName: string, activeCount: number): string =>
    `${groupName} · ${activeCount} active`,
  /** Presence row: `Sarah nearby`. */
  presenceNearby: (name: string): string => `${name} nearby`,

  // ------------------------------------------------------------------ SCREEN 06–07 posts
  post: 'Post',
  audience: 'Audience',
  addPlace: 'Add place',
  /** Human indicator on post detail / profiles. */
  human: 'Human',
  reply: 'Reply',
  replies: 'Replies',

  // ------------------------------------------------------------------ SCREEN 08–12 chats
  chats: 'Chats',
  newChat: 'New chat',
  search: 'Search',
  /** Composer placeholder: `+ Message… microphone camera`. */
  messagePlaceholder: 'Message…',
  composerActions: {
    photoVideo: 'Photo/video',
    file: 'File',
    poll: 'Poll',
    place: 'Place',
    here: 'Here',
  },
  /** Chats row: `College — Maya + 2 live` · `Family — Dad: photo` · `Saturday — 4 nearby`. */
  chatRowLine: (conversationName: string, state: string): string =>
    joinWithDash(conversationName, state),
  /** Chats row state: `Maya + 2 live`. Empty when nobody is live. */
  chatRowLive: (names: readonly string[], total?: number): string => namesLive(names, total),
  /** Chats row state: `4 nearby`. */
  chatRowNearby: (count: number): string => `${count} nearby`,
  /** Chats row preview: `Dad: photo`. */
  messagePreview: (senderName: string, preview: string): string => `${senderName}: ${preview}`,
  /** Group chat contextual line: `3 live · Join`. */
  liveJoinLine: (liveCount: number): string => `${liveCount} live · Join`,
  groupInfo: {
    members: 'Members',
    media: 'Media',
    searchMessages: 'Search messages',
    currentPlan: 'Current plan',
    locationSharing: 'Location sharing',
    notifications: 'Notifications',
    mute: 'Mute',
    leaveGroup: 'Leave group',
    removeMember: 'Remove member',
    inviteLinks: 'Invite links',
    promoteModerator: 'Promote to moderator',
  },

  // ------------------------------------------------------------------ SCREEN 13–16 Live
  /** `Xavier is live` · `Xavier + Kavon are live` · `Weekend Crew is live`. */
  liveTitle,
  groupLiveTitle,
  joinAudio: 'Join audio',
  joinOnCamera: 'Join on camera',
  joinAudioOnly: 'Join audio only',
  justWatch: 'Just watch',
  openUp: 'Open up',
  whoCanJoin: 'Who can join',
  visibility: visibilityLabels,
  joinPolicies: joinPolicyLabels,
  /**
   * SCREEN 16 participant consent. `visibility` is the room's (pending) visibility:
   * `Xavier's room is visible to World. If you join on camera, people on Earth may see that you're here.`
   */
  consent: (initiatorName: string, visibility: RoomVisibilityKey): string =>
    `${initiatorName}'s room is visible to ${visibilityLabels[visibility]}. If you join on camera, people on Earth may see that you're here.`,
  /** §61 moderator-transfer toast. */
  keepingRoomOpen: "You're keeping the room open.",
  roomControls: {
    microphone: 'Microphone',
    camera: 'Camera',
    flipCamera: 'Flip camera',
    participants: 'Participants',
    more: 'More',
    leave: 'Leave',
  },

  // ------------------------------------------------------------------ SCREEN 17–19 Guest
  joinAsGuest: 'Join as Guest',
  yourName: 'Your name',
  join: 'Join',
  openInEarth: 'Open in Earth',
  guest: 'Guest',
  guestPostRoom: 'Good hanging out. Claim your place if you want to stay connected on Earth.',
  claimMyPlace: 'Claim my place',
  done: 'Done',
  /** `You've joined 3 Earth rooms with 11 people you know.` — followed by `Claim your place`. */
  guestRepeat: (roomCount: number, peopleCount: number): string =>
    `You've joined ${pluralize(roomCount, 'Earth room')} with ${pluralize(peopleCount, 'person', 'people')} you know.`,

  // ------------------------------------------------------------------ PART XX failure states
  waitingForConnection: 'Waiting for connection',
  /** §107: Live requires network and must say so clearly. */
  connectionUnavailable: 'Connection unavailable',
  /** §108 failed optimistic message. */
  tapToRetry: 'Tap to retry',
  reconnecting: 'Reconnecting…',
  couldntReconnect: "Couldn't reconnect",
  tryAgain: 'Try again',
  leave: 'Leave',
  couldntRefresh: "Couldn't refresh",
  /** §111 verification inconclusive. Never "Verification failed." */
  getHelpVerifying: 'Get help verifying',
  /** §111 likely duplicate. */
  recoverYourPlace: 'Recover your place',

  // ------------------------------------------------------------------ §78 verification privacy
  verificationPrivacy:
    'Earth verifies that one real person is claiming one place. Your verification details are private.',

  // ------------------------------------------------------------------ §75 location sharing
  shareWith: (name: string): string => `Share with ${name}`,
  durations: {
    oneHour: '1 hour',
    tonight: 'Tonight',
    custom: 'Custom',
  },

  // ------------------------------------------------------------------ SCREEN 21 search
  searchSections: {
    people: 'People',
    groups: 'Groups',
    places: 'Places',
    posts: 'Posts',
  },
  /** People result: `Xavier — 8 mutual friends · San Francisco` (detail from `mutualLine`). */
  searchPersonLine: (name: string, detail: string): string => joinWithDash(name, detail),

  // ------------------------------------------------------------------ SCREEN 22 profile
  profileActions: {
    addFriend: 'Add Friend',
    friends: 'Friends',
    follow: 'Follow',
    following: 'Following',
    message: 'Message',
    more: 'More',
  },

  // ------------------------------------------------------------------ SCREEN 23 notifications
  notificationsTitle: 'Notifications',
  /** One-line row: `Xavier is live — Cooking dinner` · `Weekend Crew is live — Xavier, Maya + 2`. */
  notificationLine: (notification: NotificationCopy): string =>
    joinWithDash(notification.title, notification.body),

  // ------------------------------------------------------------------ SCREEN 24 You
  yourEarth: 'Your Earth',

  // ------------------------------------------------------------------ SCREEN 25 settings
  settings: {
    title: 'Settings',
    sections: {
      account: {
        title: 'Account',
        items: {
          displayIdentity: 'Display identity',
          handle: 'Handle',
          accessCredentials: 'Access credentials',
          recovery: 'Recovery',
          deactivateOrDelete: 'Deactivate or delete',
        },
      },
      privacy: {
        title: 'Privacy',
        items: {
          profile: 'Profile',
          defaultPostAudience: 'Default post audience',
          liveDefaults: 'Live defaults',
          location: 'Location',
        },
      },
      notifications: {
        title: 'Notifications',
        items: {
          messages: 'Messages',
          live: 'Live',
          social: 'Social',
          engagement: 'Engagement',
        },
      },
      safety: {
        title: 'Safety',
        items: {
          blockedHumans: 'Blocked Humans',
          reportHistory: 'Report history',
        },
      },
      humanIdentity: {
        title: 'Human identity',
        items: {
          humanPassStatus: 'Human Pass status',
          recoveryAndHelp: 'Recovery and help',
        },
      },
    },
  },

  // ------------------------------------------------------------------ §81 safety controls
  safety: {
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
  },
  reportReasons: reportReasonLabels,

  // ------------------------------------------------------------------ §86 notifications
  notifications: {
    /** `Xavier` + message preview. */
    directMessage: (senderName: string, preview: string): NotificationCopy => ({
      title: senderName,
      body: preview,
    }),
    /** `Weekend Crew` + `Maya: message preview`. */
    groupMessage: (groupName: string, senderName: string, preview: string): NotificationCopy => ({
      title: groupName,
      body: `${senderName}: ${preview}`,
    }),
    /** `Xavier is live` + `Cooking dinner`; without an activity the body invites: `Join them`. */
    friendLive: (name: string, activity?: string | null): NotificationCopy => ({
      title: liveTitle([name], 1),
      body: activityOrPrompt(activity),
    }),
    /** `Xavier + Maya are live` + `Join them`. A multi-person Live always names ≥ 2 people. */
    multiLive: (names: readonly string[], total?: number): NotificationCopy => ({
      title: liveTitle(names, Math.max(total ?? names.length, 2)),
      body: LIVE_JOIN_PROMPT,
    }),
    /** `Weekend Crew is live` + `Xavier, Maya + 2`. */
    groupLive: (groupName: string, names: readonly string[], total?: number): NotificationCopy => ({
      title: groupLiveTitle(groupName),
      body: namesWithPlus(names, total === undefined ? {} : { total }),
    }),
    /** `Maya wants to be friends`. */
    friendRequest: (name: string): NotificationCopy => ({
      title: `${name} wants to be friends`,
      body: '',
    }),
    /** `You and Maya are friends`. */
    friendAccepted: (name: string): NotificationCopy => ({
      title: `You and ${name} are friends`,
      body: '',
    }),
    /** `Sam followed you`. */
    follow: (name: string): NotificationCopy => ({ title: `${name} followed you`, body: '' }),
    /** `Xavier brought you into Weekend Crew`. */
    groupInvitation: (name: string, groupName: string): NotificationCopy => ({
      title: `${name} brought you into ${groupName}`,
      body: '',
    }),
  },
} as const

export type Copy = typeof copy

/** Consent choices (SCREEN 16) in display order, each bound to the media state it grants. */
export const CONSENT_CHOICES: ReadonlyArray<{
  readonly mediaState: MediaStateKey
  readonly label: string
}> = [
  { mediaState: 'camera', label: copy.joinOnCamera },
  { mediaState: 'audio', label: copy.joinAudioOnly },
  { mediaState: 'watching', label: copy.justWatch },
]

/** Typed input for `renderNotificationCopy`, one variant per notification type. */
export type NotificationCopyInput =
  | { type: 'direct_message'; senderName: string; preview: string }
  | { type: 'group_message'; groupName: string; senderName: string; preview: string }
  | { type: 'friend_live'; name: string; activity?: string | null }
  | { type: 'multi_live'; names: readonly string[]; total?: number }
  | { type: 'group_live'; groupName: string; names: readonly string[]; total?: number }
  | { type: 'friend_request'; name: string }
  | { type: 'friend_accepted'; name: string }
  | { type: 'follow'; name: string }
  | { type: 'group_invitation'; name: string; groupName: string }

// Compile-time proof that every notification type has exactly one input variant.
type _NotificationInputCoversEveryType = NotificationTypeKey extends NotificationCopyInput['type']
  ? NotificationCopyInput['type'] extends NotificationTypeKey
    ? true
    : never
  : never
const _notificationInputCoversEveryType: _NotificationInputCoversEveryType = true
void _notificationInputCoversEveryType

/** Dispatches on the notification type to the §86 builder. Exhaustive. */
export function renderNotificationCopy(input: NotificationCopyInput): NotificationCopy {
  const n = copy.notifications
  switch (input.type) {
    case 'direct_message':
      return n.directMessage(input.senderName, input.preview)
    case 'group_message':
      return n.groupMessage(input.groupName, input.senderName, input.preview)
    case 'friend_live':
      return n.friendLive(input.name, input.activity)
    case 'multi_live':
      return n.multiLive(input.names, input.total)
    case 'group_live':
      return n.groupLive(input.groupName, input.names, input.total)
    case 'friend_request':
      return n.friendRequest(input.name)
    case 'friend_accepted':
      return n.friendAccepted(input.name)
    case 'follow':
      return n.follow(input.name)
    case 'group_invitation':
      return n.groupInvitation(input.name, input.groupName)
    default: {
      const exhaustive: never = input
      throw new Error(`Unknown notification type: ${String(exhaustive)}`)
    }
  }
}
