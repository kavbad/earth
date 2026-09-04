/**
 * The claim completion (spec §49) as an external store for `useSyncExternalStore`: written by
 * the Human Pass screen when `claim_complete()` succeeds, read by "You're on Earth", cleared when
 * the person enters their group. Lives for the app process (the web keeps it in session storage).
 */
import type { ClaimCompletionRecord } from './flow'

let current: ClaimCompletionRecord | null = null
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

export function getCompletionSnapshot(): ClaimCompletionRecord | null {
  return current
}

export function setCompletion(record: ClaimCompletionRecord): void {
  current = record
  notify()
}

export function consumeCompletion(): void {
  current = null
  notify()
}
