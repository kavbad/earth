/**
 * The exact strings the journeys look for. Everything the spec quotes lives in `@earth/ui`; the
 * web client's own microcopy (field labels, error lines) lives next to the screens. Journeys
 * import from here so no spec ever retypes a sentence — a copy change breaks the journey at the
 * import, not at a mystery selector.
 */
import { createRequire } from 'node:module'

import type { ChatCopy } from '../../apps/web/components/chats/copy'
import type { PostCopy } from '../../apps/web/components/posts/copy'
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
