/**
 * The Guest session this device just used, kept for the claim flow's Guest → Human attribution
 * (`human_claimed.guestSessionId`, spec §100). Session-scoped: it never outlives the tab.
 */
import { type GuestSessionId, GuestSessionIdSchema, type RoomId, RoomIdSchema } from '@earth/domain'
import { z } from 'zod'

import { type KeyValueStorage, readJson, writeJson } from '../../../lib/storage'

export const GUEST_LAST_SESSION_KEY = 'earth.guest.lastSession' as const

export const GuestSessionMemoSchema = z.object({
  guestSessionId: GuestSessionIdSchema,
  roomId: RoomIdSchema,
  leftAt: z.number().int().nonnegative(),
})
export type GuestSessionMemo = z.infer<typeof GuestSessionMemoSchema>

export function rememberGuestSession(
  store: KeyValueStorage | null,
  memo: { guestSessionId: GuestSessionId; roomId: RoomId; leftAt: number },
): void {
  writeJson(store, GUEST_LAST_SESSION_KEY, memo)
}

export function readGuestSession(store: KeyValueStorage | null): GuestSessionMemo | null {
  return readJson(store, GUEST_LAST_SESSION_KEY, (value) => {
    const parsed = GuestSessionMemoSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  })
}
