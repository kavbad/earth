/**
 * Web microcopy for the safety controls (spec §56, §81–§82) at moments the spec leaves unnamed.
 * The control names — Block, Report, Hide, Block author, Leave, Remove — and the report reasons
 * come from `@earth/ui`'s `copy` and are never restated here.
 */
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
