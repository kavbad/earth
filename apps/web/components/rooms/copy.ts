/**
 * Web-only microcopy for the room, Live and Guest surfaces at moments the spec leaves unnamed.
 * Everything the spec quotes (SCREEN 13–19, §59, §61, §109) comes from `@earth/ui`'s `copy` and is
 * never restated here; the values below are labels, hints and error lines around them.
 */
import type { RoomJoinPolicy, Scope } from '@earth/domain'

export const roomCopy = {
  // SCREEN 13 — Live Home
  liveTitle: 'Live',
  nobodyLive: (scope: Scope): string =>
    scope === 'friends' ? 'Nobody you know is live right now.' : 'Nobody is live here right now.',
  publicLiveOff: 'Public Lives are not open yet.',

  // SCREEN 14 — Active Room
  connecting: 'Connecting…',
  watching: (count: number): string => (count === 1 ? '1 watching' : `${count} watching`),
  you: 'You',
  moderator: 'Moderator',
  initiator: 'Started the room',
  viewer: 'Watching',
  waiting: 'Waiting to join',
  admit: 'Admit',
  blockFromRoom: 'Remove and block from this room',
  removedFromRoom: 'You were removed from this room.',
  roomEnded: 'This room has ended.',
  backToLive: 'Back to Live',
  couldntOpenRoom: "Couldn't open this room.",
  roomNotVisible: "This room isn't open to you.",
  joinNotAllowed: "You can't join this room right now.",
  micPermission: 'Earth needs microphone access to join audio.',
  cameraPermission: 'Earth needs camera access to join on camera.',
  couldntChange: "That didn't go through.",
  someone: 'Someone',
  groupChat: 'Group chat',
  noMessagesYet: 'No messages yet.',
  send: 'Send',
  visibleTo: (label: string): string => `Visible to ${label}`,
  joinPolicyLine: (label: string): string => `Who can join: ${label}`,

  // SCREEN 15 — Open up
  currentVisibility: 'Right now',
  pendingVisibility: (label: string): string =>
    `Opening up to ${label} once everyone on camera agrees.`,
  pendingCount: (count: number): string =>
    count === 1 ? 'Waiting for 1 person on camera.' : `Waiting for ${count} people on camera.`,
  consentAllRequired: 'When a room opens outward, everyone on camera decides for themselves.',
  applyVisibility: 'Apply',
  joinPolicyDescriptions: {
    invited_only: 'Only people invited to this room can join.',
    group: 'Members of this group can join.',
    friends: 'Friends of everyone on camera can join.',
    friends_of_friends: 'Friends of everyone on camera, and their friends, can join.',
    request: 'Anyone who can see the room can ask to join.',
    anyone_with_link: 'Anyone with the link can join.',
    anyone: 'Anyone who can see the room can join.',
  } as const satisfies Record<RoomJoinPolicy, string>,

  // More sheet
  linkCopied: 'Link copied',
  linkReady: 'Share this link',
  allowGuests: 'Allow Guests',
  endRoomConfirm: 'End the room for everyone?',
  endRoomYes: 'End room',
  reportTitle: 'Report this room',
  reportSent: 'Thanks. Someone will take a look.',

  // SCREEN 17–19 — Guest
  invitedBy: (name: string): string => `Shared by ${name}`,
  roomIsLive: 'Live now',
  guestNameHint: 'How people in the room will see you.',
  guestNameMissing: 'Add a name so people know who joined.',
  cameraPreview: 'Camera preview',
  cameraPreviewOff: 'Turn off preview',
  cameraUnavailable: "Camera isn't available here. You can still join with audio.",
  guestsNotAllowed: "This room isn't taking Guests right now.",
  linkNotUsable: "This link doesn't lead anywhere anymore.",
  joiningRoom: 'Joining…',
  guestJoinFailed: "Couldn't join the room. Try again.",
  claimYourPlaceLine: 'Claim your place',
} as const

export type RoomCopy = typeof roomCopy
