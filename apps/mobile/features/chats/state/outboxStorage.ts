/**
 * Where a conversation's outbox lives on the device (spec §107 "chat messages can queue"): one
 * storage key per Human and conversation, through the guarded store so a broken store simply
 * forgets the queue on relaunch. `@earth/realtime`'s outbox validates whatever comes back.
 */
import type { OutboxItem, OutboxStorage } from '@earth/realtime'

import { type KeyValueStorage, readJson, writeJson } from '../storage'

export function outboxStorageKey(humanId: string, conversationId: string): string {
  return `earth.outbox.${humanId}.${conversationId}`
}

export function createOutboxStorage(
  store: KeyValueStorage | null,
  humanId: string,
  conversationId: string,
): OutboxStorage {
  const key = outboxStorageKey(humanId, conversationId)
  return {
    async get() {
      return (await readJson(store, key, (value) => (Array.isArray(value) ? value : null))) ?? []
    },
    set(items: readonly OutboxItem[]) {
      return writeJson(store, key, items)
    },
  }
}
