/**
 * Microcopy of SCREEN 20 (Earth map), SCREEN 24–25 (You, Settings), location sharing (spec §75)
 * and the safety controls (spec §81–§82) at moments the spec leaves unnamed. Everything the spec
 * quotes — the radius labels, "Share with …", the durations, "Couldn't refresh", the settings
 * section and item names, "Your Earth", Block / Report / Hide / Block author / Leave / Remove,
 * the report reasons, "Get help verifying", "Recover your place", the verification privacy line —
 * comes from `@earth/ui`'s `copy` and is never restated here. The strings match the web client's
 * `components/{map,location,safety}/copy.ts` and `app/(app)/you/_lib/copy.ts` character for
 * character so both clients read the same.
 */
import type {
  HumanPassStatus,
  LocationAudienceType,
  LocationPrecision,
  ProfileVisibility,
  Scope,
} from '@earth/domain'

export const earthCopy = {
  // Shell-level words the shell agent may also define; kept here so this feature stands alone.
  back: 'Back',
  close: 'Close',
  retry: 'Retry',
  loading: 'Loading',
  radiusLabel: 'Radius',
  signOut: 'Sign out',
  somethingWrong: "That didn't go through.",
  tooManyTries: 'Too many tries. Give it a minute.',
  checkAddress: "That doesn't look right. Check it and try again.",
  codeInvalid: "That code didn't work. Check it and try again.",
  continue: 'Continue',
  sendCode: 'Send code',
  sendAgain: 'Send again',
  codeLabel: 'Code',
  email: 'Email',
  phone: 'Phone',
  emailLabel: 'Email address',
  phoneLabel: 'Phone number',
  phoneHint: 'Include the country code, like +1 415 555 0100.',
  displayNameHint: 'How people on Earth will see you.',
  handleHint: 'Letters, numbers and underscores.',
  handleChecking: 'Checking…',
  handleAvailable: 'Available',
  handleTaken: 'That handle is taken.',
  handleInvalid: "That handle can't be used.",
  choosePhoto: 'Choose photo',
  changePhoto: 'Change photo',
  photosPermission: 'Earth needs access to your photos to set your picture.',
} as const

export const mapCopy = {
  mapLabel: 'Earth map',
  useMyLocation: 'Use my location',
  locating: 'Finding where you are…',
  locationDenied: "Earth can't see your location. You can allow it in Settings.",
  locationUnavailable: "Couldn't find where you are.",
  locationUnsupported: "This device can't share a location.",
  openSettings: 'Open Settings',
  needLocation: (scope: Scope): string =>
    scope === 'neighborhood'
      ? 'Set where you are to see your Neighborhood.'
      : 'Set where you are to see your City.',
  listView: 'List',
  mapView: 'Map',
  nothingHere: 'Nothing on the map here yet.',
  liveHere: (count: number): string => (count === 1 ? '1 live here' : `${count} live here`),
  participants: (count: number): string => (count === 1 ? '1 person' : `${count} people`),
  inArea: 'Nearby',
  momentBy: (name: string): string => `Moment by ${name}`,
  sections: {
    lives: 'Live',
    friends: 'Friends',
    places: 'Places',
    moments: 'Moments',
  },
  precision: {
    city: 'City',
    approximate: 'Approximate',
    precise: 'Precise',
  } as const satisfies Record<LocationPrecision, string>,
  sharingUntil: (time: string): string => `Sharing until ${time}`,
  shareWhereYouAre: 'Share where you are',
  guestsNoMap: 'The map is for people on Earth.',
  worldOff: 'The World map is not open yet.',
  openRoom: (title: string): string => `Open ${title}`,
  openPlace: (name: string): string => `Open ${name}`,
  zoomIn: 'Zoom in',
  loadingMap: 'Loading the map…',
  mapFailed: "The map couldn't load.",
} as const

export type MapCopy = typeof mapCopy

export const locationCopy = {
  precision: mapCopy.precision,
  precisionHint: {
    city: 'Only which city you are in.',
    approximate: 'Within a few blocks.',
    precise: 'Exactly where you are.',
  } as const satisfies Record<LocationPrecision, string>,
  precisionLabel: 'How precisely',
  durationLabel: 'For how long',
  customLabel: 'Custom length',
  hours: (count: number): string => (count === 1 ? '1 hour' : `${count} hours`),
  minutes: (count: number): string => `${count} min`,
  share: 'Share',
  chooseAudience: 'Share with',
  noAudiences: 'Sharing starts with a group. Join or start one first.',
  sharingOff: 'Location sharing is not open yet.',
  boundedNote: 'Sharing ends on its own. Never forever.',
  positionNeeded: 'Earth needs your location to share it.',
  sharedWith: (name: string): string => `Sharing with ${name}`,
  until: (time: string): string => `until ${time}`,
  stopSharing: 'Stop sharing',
  stopped: 'Stopped sharing.',
  yourShares: 'You are sharing',
  friendsSharing: 'Sharing with you',
  nothingShared: "You're not sharing where you are.",
  noFriendsSharing: 'Nobody is sharing with you right now.',
  showOnMap: (name: string): string => `Show ${name} on the map`,
  /** A share the server knows but this device never named (started elsewhere). */
  unknownAudience: {
    friend: 'A friend',
    group: 'A group',
    temporary_context: 'Here',
  } as const satisfies Record<LocationAudienceType, string>,
} as const

export type LocationCopy = typeof locationCopy

export const safetyCopy = {
  menuTitle: 'More',
  reportTitle: 'Report',
  reportSent: 'Thanks. Someone will take a look.',
  reportHint: 'Reports are private. The person is not told who reported them.',
  blockTitle: (name: string): string => `Block ${name}?`,
  blockBody: (name: string): string =>
    `${name} won't be able to message you, and you won't be shown to each other on Earth.`,
  /** Spec §56: group coexistence must be understandable. */
  blockGroups:
    "If you're in a group together, you both stay in it. The group keeps working, but nothing between the two of you shows up directly.",
  blocked: (name: string): string => `${name} is blocked.`,
  unblocked: (name: string): string => `${name} is unblocked.`,
  hidden: 'Hidden.',
  removeTitle: (name: string): string => `Remove ${name}?`,
  removeBody: 'They leave the room now.',
  removeAndBlock: 'Remove and block from this room',
  removed: (name: string): string => `${name} was removed.`,
  couldnt: "That didn't go through.",
  onlyHumans: 'Safety controls are for people on Earth.',
} as const

export type SafetyCopy = typeof safetyCopy

export const youCopy = {
  // SCREEN 24
  yourEarthLine: 'Your Moments around your home city.',
  posts: 'Posts',
  noPostsYet: 'Nothing posted yet.',
  counts: (friends: number, followers: number, following: number): string =>
    `${friends} ${friends === 1 ? 'friend' : 'friends'} · ${followers} ${followers === 1 ? 'follower' : 'followers'} · ${following} following`,
  notOnEarthYet: "You're not on Earth yet.",
  finishClaim: 'Finish claiming your place',
  signOutConfirm: 'Sign out of Earth on this device?',

  // SCREEN 25 — shared
  saved: 'Saved.',
  save: 'Save',
  cancel: 'Cancel',
  back: 'Back',

  // Account
  bio: 'Bio',
  bioHint: 'A line about you. Optional.',
  handleChangeSoon: 'Changing your handle is not available yet.',
  handleSame: 'That is your handle.',
  credentials: 'How you sign in',
  noCredential: 'None',
  addEmail: 'Add email',
  addPhone: 'Add phone',
  codeSentTo: (destination: string): string => `We sent a code to ${destination}.`,
  credentialAdded: 'Added.',
  credentialsUnavailable: 'Adding a way to sign in is not available right now.',
  recoveryLine:
    'If you lose access, recovery checks enough about you to restore your place. It never creates a second one.',
  startRecovery: 'Start recovery',
  deleteTitle: 'Delete my account',
  deleteBody:
    'A person will review the request and delete your place on Earth. You will be signed out now.',
  deleteConfirm: 'Delete my account',
  deleteRequested: 'Your request is in. You are signed out.',

  // Privacy
  profileVisibility: {
    public: 'Public',
    limited: 'Limited',
    hidden: 'Hidden',
  } as const satisfies Record<ProfileVisibility, string>,
  profileVisibilityHint: {
    public: 'Anyone on Earth can find you.',
    limited: 'Friends and people in your groups can find you.',
    hidden: 'Only friends see your profile.',
  } as const satisfies Record<ProfileVisibility, string>,
  showCity: 'Show my city on my profile',
  defaultAudienceHint: 'New posts start with this audience. You can change it every time.',
  liveDefaultsHint: 'How your Lives start. You can open up any room later.',
  liveVisibility: 'Visible to',
  liveJoinPolicy: 'Who can join',
  storedOnDevice: 'Remembered on this device.',
  homeCity: 'Home city',
  homeCityHint: 'Where your Earth centres.',
  searchCity: 'Search a city',
  noCityFound: 'No city by that name.',
  manageSharing: 'See who you are sharing with',

  // Notifications
  pushTitle: 'Push notifications',
  pushOn: 'On',
  pushOff: 'Off',
  pushUndetermined: 'Not asked yet',
  pushDeniedHint: 'Turn notifications on for Earth in Settings.',
  pushOffHint: 'Earth only sends the notifications you choose here.',
  allowNotifications: 'Allow notifications',
  openSettings: 'Open Settings',
  perConversation: 'Per conversation',
  perConversationHint: 'Mute and notification level for each chat.',
  conversationPrefsLine: 'Mute and notification level',
  noChatsYet: 'No chats yet.',
  categoryHint: {
    messages: 'Direct and group messages.',
    live: 'Friends and groups going live.',
    social: 'Friend requests and follows.',
    engagement: 'Reactions and replies. Quieter.',
  },

  // Safety
  nobodyBlocked: 'Nobody is blocked.',
  noReports: 'No reports yet.',
  reportLine: (reason: string, target: string): string => `${reason} · ${target}`,
  reportStatus: {
    open: 'Open',
    in_review: 'Being reviewed',
    resolved: 'Resolved',
    dismissed: 'Closed',
  },
  reportTargets: {
    human: 'Human',
    post: 'Post',
    room: 'Room',
    message: 'Message',
    guest: 'Guest',
    group: 'Group',
  },

  // Human identity
  humanPass: {
    unverified: 'Not verified',
    verifying: 'Verifying',
    verified: 'Verified',
    review_required: 'A person is reviewing',
    rejected: 'Not verified',
  } as const satisfies Record<HumanPassStatus, string>,
  helpRequested: 'Thanks. A person will review this and get back to you.',
  recoveryRequested: "We'll help you get back into your place.",
} as const

export type YouCopy = typeof youCopy
