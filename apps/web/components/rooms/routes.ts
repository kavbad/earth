/**
 * Routes owned by the rooms and Live surfaces (spec §112 deep links, SCREEN 13–19). Built on the
 * shell's `asRoute` so no screen spells a path as a string literal.
 */
import { DEEP_LINK_PATHS } from '@earth/domain'
import type { Route } from 'next'

import { ROUTES, asRoute } from '../../lib/routes'

/** `/rooms` — the Active Room lives outside the member shell (full-screen, no tab bar). */
export const ROOMS_PATH = '/rooms' as const

/** Custom scheme the installed app answers (spec §112: universal link → native destination). */
export const APP_SCHEME = 'earth' as const

/** Query key the claim flow may read to attribute a Guest → Human conversion (spec §100). */
export const CLAIM_ENTRY_QUERY = 'entry' as const

/** `/rooms/<roomId>` — SCREEN 14. */
export function roomRoute(roomId: string): Route {
  return asRoute(`${ROOMS_PATH}/${encodeURIComponent(roomId)}`)
}

/** `/live/<token>` — the Guest room deep link (SCREEN 17). */
export function guestRoomRoute(token: string): Route {
  return asRoute(`${DEEP_LINK_PATHS.roomInvite}${encodeURIComponent(token)}`)
}

/** `earth://live/<token>` — "Open in Earth" (never forced). */
export function appRoomLink(token: string): string {
  return `${APP_SCHEME}:/${DEEP_LINK_PATHS.roomInvite}${encodeURIComponent(token)}`
}

/** `/claim?entry=guest_room` — SCREEN 19 "Claim my place" carries the conversion context. */
export function claimFromGuestRoomRoute(): Route {
  return asRoute(`${ROUTES.claim}?${CLAIM_ENTRY_QUERY}=guest_room`)
}

/** `/claim?entry=room_invite` — a Visitor on a room link who cannot enter as Guest. */
export function claimFromRoomInviteRoute(): Route {
  return asRoute(`${ROUTES.claim}?${CLAIM_ENTRY_QUERY}=room_invite`)
}
