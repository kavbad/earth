/**
 * SCREEN 12 rules, pure: the "new group" rule behind "Bring them here" (spec §45 step 10), role
 * labels, client-side message search (V1 searches loaded messages), notification prefs, and the
 * media grid's entries.
 */
import type { GroupDetailDto, GroupMemberDto, MessageDto } from '@earth/domain'
import { z } from 'zod'

import { chatCopy } from '../copy'
import { type MediaPayload, parseMediaPayload } from '../payloads'

/** A group is "new" while it is mostly its founder. */
export const NEW_GROUP_MEMBER_MAX = 2
export const NEW_GROUP_DAYS = 7
/** How many `messages_list` pages the info screen loads for media and search. */
export const INFO_MESSAGE_PAGES = 4
export const MEDIA_GRID_MAX = 30
export const SEARCH_RESULTS_MAX = 50

export function isNewGroup(
  group: Pick<GroupDetailDto, 'memberCount' | 'createdAt'>,
  now: Date = new Date(),
): boolean {
  if (group.memberCount <= NEW_GROUP_MEMBER_MAX) return true
  const ageMs = now.getTime() - Date.parse(group.createdAt)
  return Number.isFinite(ageMs) && ageMs < NEW_GROUP_DAYS * 24 * 3600_000
}

export function roleLabel(role: GroupMemberDto['role']): string {
  switch (role) {
    case 'owner':
      return chatCopy.owner
    case 'moderator':
      return chatCopy.moderator
    case 'member':
      return chatCopy.member
  }
}

/** `Owner · Friend` · `Friend` · `` — the relation line under a member's name. */
export function memberRelationLine(member: Pick<GroupMemberDto, 'role' | 'isFriend'>): string {
  return [
    member.role !== 'member' ? roleLabel(member.role) : null,
    member.isFriend ? chatCopy.friend : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

/** Client-side message search over loaded messages (V1; server search covers posts, not chats). */
export function searchMessages(messages: readonly MessageDto[], query: string): MessageDto[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  return messages
    .filter(
      (message) =>
        message.deletedAt === null && (message.text ?? '').toLowerCase().includes(needle),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export interface MediaEntry {
  readonly message: MessageDto
  readonly media: MediaPayload
}

/** Photos and videos among the loaded messages, newest first as the pages arrive. */
export function mediaEntries(messages: readonly MessageDto[]): MediaEntry[] {
  const entries: MediaEntry[] = []
  for (const message of messages) {
    if ((message.type !== 'image' && message.type !== 'video') || message.deletedAt !== null)
      continue
    const media = parseMediaPayload(message.payload)
    if (media !== null) entries.push({ message, media })
  }
  return entries
}

/** The current plan (spec SCREEN 12 "current plan if any"): the newest non-deleted `plan` message. */
export function currentPlan(messages: readonly MessageDto[]): MessageDto | null {
  return messages.find((message) => message.type === 'plan' && message.deletedAt === null) ?? null
}

// ---------------------------------------------------------------------------
// Notification prefs (no read RPC in V1: the device remembers what was last set)
// ---------------------------------------------------------------------------

export const PrefsSchema = z.object({
  muteState: z.enum(['none', 'muted']),
  notificationLevel: z.enum(['all', 'mentions', 'none']),
})
export type Prefs = z.infer<typeof PrefsSchema>
export const DEFAULT_PREFS: Prefs = { muteState: 'none', notificationLevel: 'all' }

export function prefsKey(conversationId: string): string {
  return `earth.chats.prefs.${conversationId}`
}

export function parsePrefs(value: unknown): Prefs | null {
  const parsed = PrefsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Whether the viewer may edit the group, invite and remove (owner or moderator). */
export function canModerate(role: GroupMemberDto['role'] | null): boolean {
  return role === 'owner' || role === 'moderator'
}
