/**
 * Post microcopy for moments the spec leaves unnamed (accessible names, sheet lines, empty and
 * failure states). Everything the spec quotes for SCREEN 06–07 (`Post`, `Audience`, `Add place`,
 * `Human`, `Reply`, `Replies`, the audience labels, `Couldn't refresh`, the report reasons) comes
 * from `@earth/ui`'s `copy` and is never restated here.
 */
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
  audioLabel: (name: string): string => `Audio from ${name}`,
  replyingTo: (name: string): string => `Replying to ${name}`,

  // SCREEN 06 composer
  compose: 'New post',
  textLabel: 'Text',
  textPlaceholder: 'Say something',
  replyPlaceholder: 'Reply…',
  addPhotoVideo: 'Photo or video',
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
