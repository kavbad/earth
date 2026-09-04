/**
 * Web microcopy for SCREEN 24–25 at moments the spec leaves unnamed. Section and item names
 * ("Account", "Display identity", "Blocked Humans", …) and "Your Earth" come from `@earth/ui`.
 */
import type { HumanPassStatus, ProfileVisibility } from '@earth/domain'

export const youCopy = {
  // SCREEN 24
  yourEarthLine: 'Your Moments around your home city.',
  posts: 'Posts',
  videoAttachment: 'Video',
  noPostsYet: 'Nothing posted yet.',
  counts: (friends: number, followers: number, following: number): string =>
    `${friends} ${friends === 1 ? 'friend' : 'friends'} · ${followers} ${followers === 1 ? 'follower' : 'followers'} · ${following} following`,
  notOnEarthYet: "You're not on Earth yet.",
  finishClaim: 'Finish claiming your place',
  signOutConfirm: 'Sign out of Earth on this browser?',

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
  webNotificationsNote:
    'Push notifications arrive on your phone in the Earth app. On the web, everything shows in Notifications.',
  perConversation: 'Per conversation',
  perConversationHint: 'Mute and notification level for each chat.',
  conversationPrefsLine: 'Mute and notification level',
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
