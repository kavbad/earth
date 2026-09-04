/**
 * SCREEN 02 presence row: "Xavier + Maya live", "Weekend Crew · 3 active", "Sarah nearby".
 *
 * `feed_presence()` (DB_API §4, migration 0973) returns the three raw sources the row is made of —
 * the viewer's Friends-radius live rooms (the `live_candidates` payload, so the rooms tier still
 * decides discoverability), the groups whose members are active right now, and the friends in the
 * viewer's current area. Naming (spec §60: active publishers only, viewer excluded, most relevant
 * first), the labels and the "only when there is meaningful state" rule come from `@earth/domain`;
 * nothing about who may be seen is decided here.
 */
import {
  type PresenceCardDto,
  type PresenceItemDto,
  PresenceItemDtoSchema,
  NonNegativeIntSchema,
  NullableUrlSchema,
  orderParticipantsForViewer,
  pickNamedParticipants,
  presenceCard,
  presenceGroupActiveLabel,
  presenceLiveLabel,
  presenceNearbyLabel,
} from '@earth/domain'
import { z } from 'zod'

import { parseOutput } from '../http'
import { type LiveRoomRow, LiveRoomRowSchema, namingParticipantsOf } from './rows'

export const FEED_PRESENCE_RPC = 'feed_presence' as const

/** A group of the viewer's with members active in its conversation right now. */
export const PresenceGroupRowSchema = z.object({
  groupId: z.uuid(),
  /** Unnamed groups never reach the row: there would be nothing to label the chip with. */
  groupName: z.string().trim().min(1),
  conversationId: z.uuid().nullable().default(null),
  activeCount: NonNegativeIntSchema,
  humanIds: z.array(z.uuid()).default([]),
  avatarUrls: z.array(NullableUrlSchema).default([]),
})
export type PresenceGroupRow = z.infer<typeof PresenceGroupRowSchema>

/** A friend in the viewer's current area (area-level only — never a position, spec §128). */
export const PresenceNearbyRowSchema = z.object({
  humanId: z.uuid(),
  displayName: z.string().trim().min(1),
  avatarUrl: NullableUrlSchema.default(null),
})
export type PresenceNearbyRow = z.infer<typeof PresenceNearbyRowSchema>

const PresenceResultShape = z.object({
  liveRooms: z.array(LiveRoomRowSchema).default([]),
  activeGroups: z.array(PresenceGroupRowSchema).default([]),
  nearbyFriends: z.array(PresenceNearbyRowSchema).default([]),
})

export const EMPTY_FEED_PRESENCE: FeedPresenceResult = {
  liveRooms: [],
  activeGroups: [],
  nearbyFriends: [],
}

export const FeedPresenceResultSchema = z.union([
  PresenceResultShape,
  z.null().transform(() => EMPTY_FEED_PRESENCE),
])
export type FeedPresenceResult = z.infer<typeof PresenceResultShape>

function urls(values: readonly (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null)
}

/**
 * "Xavier + Maya live" for a room at least one of whose nameable publishers is a friend — a room
 * full of strangers, or one only the viewer publishes in, is not presence. `null` when the room
 * does not qualify.
 */
export function friendsLiveItem(room: LiveRoomRow): PresenceItemDto | null {
  const ordered = orderParticipantsForViewer(namingParticipantsOf(room))
  if (!ordered.some((participant) => participant.relation === 'friend')) return null
  const named = pickNamedParticipants(ordered)
  const label = presenceLiveLabel(
    named.map((participant) => participant.displayName),
    room.participantCount ?? ordered.length,
  )
  if (label === '') return null
  return parseOutput(
    PresenceItemDtoSchema,
    {
      type: 'friends_live',
      label,
      humanIds: named.map((participant) => participant.humanId).filter((id) => id !== null),
      roomId: room.roomId,
      conversationId: null,
      groupId: null,
      avatarUrls: urls(named.map((participant) => participant.avatarUrl)),
    },
    'PresenceItemDto',
  )
}

/** "Weekend Crew · 3 active" — the chip opens the group's conversation. */
export function groupActiveItem(group: PresenceGroupRow): PresenceItemDto {
  return parseOutput(
    PresenceItemDtoSchema,
    {
      type: 'group_active',
      label: presenceGroupActiveLabel(group.groupName, group.activeCount),
      humanIds: group.humanIds,
      roomId: null,
      conversationId: group.conversationId,
      groupId: group.groupId,
      avatarUrls: urls(group.avatarUrls),
    },
    'PresenceItemDto',
  )
}

/** "Sarah nearby" — no destination: presence, not a location. */
export function nearbyFriendItem(friend: PresenceNearbyRow): PresenceItemDto {
  return parseOutput(
    PresenceItemDtoSchema,
    {
      type: 'friend_nearby',
      label: presenceNearbyLabel(friend.displayName),
      humanIds: [friend.humanId],
      roomId: null,
      conversationId: null,
      groupId: null,
      avatarUrls: urls([friend.avatarUrl]),
    },
    'PresenceItemDto',
  )
}

/** The page's presence card, or `null` when nothing meaningful is happening (SCREEN 02). */
export function presenceCardFrom(result: FeedPresenceResult): PresenceCardDto | null {
  const items: PresenceItemDto[] = []
  for (const room of result.liveRooms) {
    const item = friendsLiveItem(room)
    if (item !== null) items.push(item)
  }
  for (const group of result.activeGroups) items.push(groupActiveItem(group))
  for (const friend of result.nearbyFriends) items.push(nearbyFriendItem(friend))
  return presenceCard(items)
}
