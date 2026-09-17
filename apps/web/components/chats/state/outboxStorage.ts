/**
 * Where a conversation's outbox lives on the device (spec §107 "chat messages can queue"): one
 * `localStorage` key per Human and conversation, through the shell's guarded storage so private
 * mode simply forgets the queue on reload.
 */
import type { OutboxItem, OutboxStorage } from '@earth/realtime'

import { type KeyValueStorage, readJson, writeJson } from '../../../lib/storage'

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
    get: () => readJson(store, key, (value) => (Array.isArray(value) ? value : null)) ?? [],
    set(items: readonly OutboxItem[]) {
      writeJson(store, key, items)
    },
  }
}
