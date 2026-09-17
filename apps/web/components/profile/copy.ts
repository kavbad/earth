/**
 * Profile microcopy for moments the spec leaves unnamed. The action labels (`Add Friend`,
 * `Friends`, `Follow`, `Following`, `Message`, `More`), `Human`, the mutual line and the safety
 * controls come from `@earth/ui` and are never restated here.
 */
export const profileCopy = {
  /** SCREEN 22 content section: "Now / posts". */
  now: 'Now',
  requested: 'Requested',
  accept: 'Accept',
  removeFriend: 'Remove friend',
  unfollow: 'Unfollow',
  profileUnavailable: "This profile isn't available.",
  noPostsYet: 'Nothing posted yet.',
  friendsCount: (count: number): string => (count === 1 ? '1 friend' : `${count} friends`),
  followersCount: (count: number): string => (count === 1 ? '1 follower' : `${count} followers`),
  followingCount: (count: number): string => `${count} following`,
  sharedGroups: (count: number): string =>
    count === 1 ? '1 shared group' : `${count} shared groups`,
  blocked: 'Blocked',
  blockConfirm: (name: string): string => `Block ${name}?`,
  blockBody: "They won't see your posts or messages, and you won't see theirs.",
  reportTitle: (name: string): string => `Report ${name}`,
  reportSent: 'Thanks. Someone will take a look.',
  couldntChange: "That didn't go through.",
  you: 'You',
  editProfile: 'Edit profile',
} as const

export type ProfileCopy = typeof profileCopy
