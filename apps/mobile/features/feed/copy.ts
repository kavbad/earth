/**
 * Home, post, profile, notifications and search microcopy for moments the spec leaves unnamed
 * (accessible names, sheet lines, empty and failure states). Everything the spec quotes (the
 * wordmark, `Add people you actually know`, the presence lines, `Couldn't refresh`, `Post`,
 * `Audience`, `Add place`, `Human`, `Reply`, `Replies`, the audience labels, the section names,
 * the notification titles, the profile actions, the safety controls and the report reasons) comes
 * from `@earth/ui`'s `copy` and is never restated here. The strings match the web client's
 * `components/{feed,posts,profile}/copy.ts` character for character so both clients read the same.
 */
import type { Scope } from '@earth/domain'

export const feedCopy = {
  // Shell-level words the shell agent may also define; kept here so this feature stands alone.
  back: 'Back',
  close: 'Close',
  retry: 'Retry',
  loading: 'Loading',
  radiusLabel: 'Radius',
  somethingWrong: "That didn't go through.",
  notFound: 'There is nothing here.',

  // SCREEN 01–05 Home
  nothingHereYet: (scope: Scope): string =>
    scope === 'friends' ? 'Nothing from your people yet.' : 'Nothing here yet.',
  publicWorldOff: 'Public World is not open yet.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  endOfFeed: "That's everything for now.",
  loadingMore: 'Loading more',
  composeEntry: 'Say something',
  newPost: 'New post',
  presenceLabel: 'Right now',
  addPeopleBody: 'Find people by name or handle.',
  findPeople: 'Find people',
  cityTitle: 'City',
  currentCity: 'Where you are',
  homeCity: 'Home city',
  changeCity: 'Change city',
  noCityYet: 'No city yet.',
  feedList: 'Feed',
  nearbyHidden: 'Only what people chose to share.',
  openNotifications: 'Notifications',
  openSearch: 'Search',

  // SCREEN 23 notifications
  nothingYet: 'Nothing yet.',
  unread: 'Unread',
  unreadCount: (count: number): string => (count === 1 ? '1 unread' : `${count} unread`),
  accept: 'Accept',
  notificationsFor: 'Notifications are for people on Earth.',

  // SCREEN 21 search
  searchPlaceholder: 'Search Earth',
  searchLabel: 'Search',
  noResults: (query: string): string => `Nothing for “${query}”.`,
  members: (count: number): string => (count === 1 ? '1 member' : `${count} members`),
  member: 'Member',
  groupFallback: 'Group',
  friend: 'Friend',
  following: 'Following',
  searchHint: 'People, groups, places and posts.',
  clearSearch: 'Clear',
} as const

export type FeedCopy = typeof feedCopy

export const postCopy = {
  // Actions row (spec §92: subdued)
  react: 'React',
  reacted: 'Reacted',
  share: 'Share',
  more: 'More',
  linkCopied: 'Link copied',
  postActions: 'Post actions',
  openPost: 'Open post',

  // Meta
  human: 'Human',
  photoAlt: (name: string): string => `Photo from ${name}`,
  videoLabel: (name: string): string => `Video from ${name}`,
  replyingTo: (name: string): string => `Replying to ${name}`,

  // SCREEN 06 composer
  compose: 'New post',
  textLabel: 'Text',
  textPlaceholder: 'Say something',
  replyPlaceholder: 'Reply…',
  addPhotoVideo: 'Photo or video',
  takePhoto: 'Take a photo or video',
  chooseFromLibrary: 'Choose from library',
  removeMedia: (index: number): string => `Remove attachment ${index}`,
  tooManyAttachments: (max: number): string => `Up to ${max} photos or videos.`,
  uploading: 'Uploading…',
  uploadFailed: "That didn't upload.",
  removePlace: 'Remove place',
  postTo: (audienceLabel: string): string => `Post to ${audienceLabel}`,
  audienceTitle: 'Who can see this',
  /** Reply composer: the root already decided how far this can go (spec §72). */
  audienceCapped: (audienceLabel: string): string => `Replies stay within ${audienceLabel}.`,
  /** SCREEN 06 stronger confirmation when moving materially outward. */
  confirmTitle: (audienceLabel: string): string => `Post to ${audienceLabel}?`,
  confirmBody: (audienceLabel: string, usualLabel: string): string =>
    `You usually post to ${usualLabel}. This one reaches ${audienceLabel}.`,
  confirmWorldBody: (usualLabel: string): string =>
    `You usually post to ${usualLabel}. World is public — anyone on Earth can see it.`,
  keepUsual: (usualLabel: string): string => `Keep it to ${usualLabel}`,
  posting: 'Posting…',
  couldntPost: "That didn't post.",
  postingIsForHumans: 'Posting is for people on Earth.',
  discard: 'Discard',
  photosPermission: 'Earth needs access to your photos to post them.',
  cameraPermission: 'Earth needs camera access to take a photo.',
  place: 'Place',
  searchPlaces: 'Search places',
  noPlacesFound: 'No places by that name.',

  // SCREEN 07 detail
  postUnavailable: "This post isn't available.",
  noRepliesYet: 'No replies yet.',
  repliesClosed: 'Replies are closed on this post.',
  loadMoreReplies: 'More replies',
  reactionCount: (count: number): string => (count === 1 ? '1 reaction' : `${count} reactions`),
  replyCount: (count: number): string => (count === 1 ? '1 reply' : `${count} replies`),

  // More sheet (spec §81 controls)
  hidden: 'Hidden',
  deletePost: 'Delete',
  deleteConfirm: 'Delete this post?',
  blockConfirm: (name: string): string => `Block ${name}?`,
  blockBody: "They won't see your posts or messages, and you won't see theirs.",
  reportTitle: 'Report this post',
  reportSent: 'Thanks. Someone will take a look.',
  somethingWrong: "That didn't go through.",
} as const

export type PostCopy = typeof postCopy

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
