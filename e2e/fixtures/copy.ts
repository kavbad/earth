/**
 * The exact strings the journeys look for. Everything the spec quotes lives in `@earth/ui`; the
 * web client's own microcopy (field labels, error lines) lives next to the screens. Journeys
 * import from here so no spec ever retypes a sentence — a copy change breaks the journey at the
 * import, not at a mystery selector.
 */
import { createRequire } from 'node:module'

import type { ChatCopy } from '../../apps/web/components/chats/copy'
import type { FeedCopy } from '../../apps/web/components/feed/copy'
import type { LocationCopy } from '../../apps/web/components/location/copy'
import type { MapCopy } from '../../apps/web/components/map/copy'
import type { PostCopy } from '../../apps/web/components/posts/copy'
import type { ProfileCopy } from '../../apps/web/components/profile/copy'
import type { RoomCopy } from '../../apps/web/components/rooms/copy'
import type { SafetyCopy } from '../../apps/web/components/safety/copy'
import type { WebCopy } from '../../apps/web/lib/copy'

export { APP_NAME, LIVE_JOIN_PROMPT, copy, namesWithPlus, participantSummary } from '@earth/ui'

/**
 * `apps/web` is a CommonJS package (no `"type": "module"`), so Playwright compiles its modules to
 * CommonJS and an ESM `import` of one cannot see its named exports. `require` can, and the types
 * above keep this exactly as safe as a plain import.
 */
const requireFromE2e = createRequire(import.meta.url)

export const webCopy: WebCopy = (
  requireFromE2e('../../apps/web/lib/copy') as { readonly webCopy: WebCopy }
).webCopy

export const chatCopy: ChatCopy = (
  requireFromE2e('../../apps/web/components/chats/copy') as { readonly chatCopy: ChatCopy }
).chatCopy

export const postCopy: PostCopy = (
  requireFromE2e('../../apps/web/components/posts/copy') as { readonly postCopy: PostCopy }
).postCopy

/** SCREEN 22 labels around the spec's own action names: "Requested", "Accept", … */
export const profileCopy: ProfileCopy = (
  requireFromE2e('../../apps/web/components/profile/copy') as { readonly profileCopy: ProfileCopy }
).profileCopy

/** SCREEN 14–19 labels around the spec's own lines: "Connecting…", "You", "1 watching", … */
export const roomCopy: RoomCopy = (
  requireFromE2e('../../apps/web/components/rooms/copy') as { readonly roomCopy: RoomCopy }
).roomCopy

/** SCREEN 01–05 labels around the spec's own lines: "New post", "Nothing from your people yet.", … */
export const feedCopy: FeedCopy = (
  requireFromE2e('../../apps/web/components/feed/copy') as { readonly feedCopy: FeedCopy }
).feedCopy

/** SCREEN 20 labels around the spec's own lines: "Earth map", "List", "Approximate", … */
export const mapCopy: MapCopy = (
  requireFromE2e('../../apps/web/components/map/copy') as { readonly mapCopy: MapCopy }
).mapCopy

/** §75 location sharing around the spec's own "Share with …", "1 hour", "Tonight", "Custom". */
export const locationCopy: LocationCopy = (
  requireFromE2e('../../apps/web/components/location/copy') as {
    readonly locationCopy: LocationCopy
  }
).locationCopy

/** §56, §81–§82 safety lines around the spec's own "Block", "Report": the group-coexistence copy. */
export const safetyCopy: SafetyCopy = (
  requireFromE2e('../../apps/web/components/safety/copy') as { readonly safetyCopy: SafetyCopy }
).safetyCopy
