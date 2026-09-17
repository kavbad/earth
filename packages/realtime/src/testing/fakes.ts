/**
 * Small fakes shared by the tests: a recording diagnostics emitter and an in-memory outbox store.
 */
import type { RealtimeDiagnostics, RtcDiagnosticEvent, RtcDiagnosticKind } from '../diagnostics'
import type { OutboxItem, OutboxStorage } from '../queue'

export interface RecordingDiagnostics extends RealtimeDiagnostics {
  readonly events: RtcDiagnosticEvent[]
  kinds(): RtcDiagnosticKind[]
}

export function createRecordingDiagnostics(): RecordingDiagnostics {
  const events: RtcDiagnosticEvent[] = []
  return {
    events,
    emit(event) {
      events.push(event)
    },
    kinds: () => events.map((event) => event.kind),
  }
}

export interface MemoryOutboxStorage extends OutboxStorage {
  /** What the last `set` persisted, or the seeded value. */
  value: unknown
  writes: number
  /** When set, `set` rejects. */
  failWrites: boolean
}

export function createMemoryOutboxStorage(seed: unknown = []): MemoryOutboxStorage {
  const storage: MemoryOutboxStorage = {
    value: seed,
    writes: 0,
    failWrites: false,
    get: () => storage.value,
    async set(items: readonly OutboxItem[]) {
      if (storage.failWrites) throw new Error('storage unavailable')
      storage.writes += 1
      storage.value = JSON.parse(JSON.stringify(items))
    },
  }
  return storage
}
