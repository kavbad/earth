/**
 * The claim completion (spec §49) as an external store for `useSyncExternalStore`: read from
 * session storage once on the client, `undefined` on the server, cleared when the person enters
 * their group.
 */
import { type ClaimCompletionRecord, clearCompletion, readCompletion } from './flow'
import { sessionStore } from '../storage'

type Snapshot = ClaimCompletionRecord | null | undefined

let cached: Snapshot = undefined
let loaded = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribeCompletion(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Client snapshot: the stored completion (read once), `null` when there is none. */
export function getCompletionSnapshot(): Snapshot {
  if (!loaded) {
    cached = readCompletion(sessionStore())
    loaded = true
  }
  return cached
}

/** Server snapshot: unknown until the client reads storage. */
export function getCompletionServerSnapshot(): Snapshot {
  return undefined
}

export function consumeCompletion(): void {
  clearCompletion(sessionStore())
  cached = null
  loaded = true
  notify()
}

/** Tests only. */
export function resetCompletionStore(): void {
  cached = undefined
  loaded = false
  notify()
}
