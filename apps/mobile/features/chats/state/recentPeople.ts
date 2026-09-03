/**
 * SCREEN 09 "Recent people": who last wrote in recent conversations plus people picked here
 * before, remembered on the device per Human. Pure apart from the injected store.
 */
import type { ConversationSummaryDto, HumanId, SearchPersonDto } from '@earth/domain'
import { asHumanId } from '@earth/domain'
import { z } from 'zod'

import { type KeyValueStorage, readJson, writeJson } from '../storage'

export const RECENT_PEOPLE_MAX = 10

export interface Person {
  readonly humanId: HumanId
  readonly displayName: string
  readonly handle: string | null
  readonly avatarUrl: string | null
}

const PersonSchema = z.object({
  humanId: z.uuid(),
  displayName: z.string().min(1),
  handle: z.string().nullable(),
  avatarUrl: z.url().nullable(),
})

export function recentPeopleKey(humanId: string): string {
  return `earth.chats.recent.${humanId}`
}

export async function readRecentPeople(
  store: KeyValueStorage | null,
  viewerId: string,
): Promise<Person[]> {
  const parsed = await readJson(store, recentPeopleKey(viewerId), (value) => {
    const result = z.array(PersonSchema).safeParse(value)
    return result.success ? result.data : null
  })
  return (parsed ?? []).map((person) => ({ ...person, humanId: asHumanId(person.humanId) }))
}

export async function rememberRecentPeople(
  store: KeyValueStorage | null,
  viewerId: string,
  people: readonly Person[],
): Promise<void> {
  const existing = await readRecentPeople(store, viewerId)
  const merged = [
    ...people,
    ...existing.filter((p) => !people.some((n) => n.humanId === p.humanId)),
  ]
  await writeJson(store, recentPeopleKey(viewerId), merged.slice(0, RECENT_PEOPLE_MAX))
}

export function personFromSearch(result: SearchPersonDto): Person {
  return {
    humanId: result.humanId,
    displayName: result.displayName,
    handle: result.handle,
    avatarUrl: result.avatarUrl,
  }
}

/**
 * Recent people to offer before typing: remembered picks first, then the last sender of each
 * recent conversation (never the viewer, never system rows), deduplicated and capped.
 */
export function recentPeople(
  remembered: readonly Person[],
  conversations: readonly ConversationSummaryDto[],
  viewerId: HumanId | null,
): Person[] {
  if (viewerId === null) return []
  const seen = new Set<string>()
  const people: Person[] = []
  for (const person of remembered) {
    if (seen.has(person.humanId)) continue
    seen.add(person.humanId)
    people.push(person)
  }
  for (const conversation of conversations) {
    const last = conversation.lastMessage
    if (last === null || last.senderHumanId === viewerId || last.type === 'system') continue
    if (seen.has(last.senderHumanId)) continue
    seen.add(last.senderHumanId)
    people.push({
      humanId: last.senderHumanId,
      displayName: last.senderDisplayName,
      handle: null,
      avatarUrl: conversation.type === 'direct' ? (conversation.avatarUrls[0] ?? null) : null,
    })
  }
  return people.slice(0, RECENT_PEOPLE_MAX)
}

/** Adds or removes a person from the selection (SCREEN 09: one → DM, two or more → group). */
export function toggleSelected(selected: readonly Person[], person: Person): Person[] {
  return selected.some((p) => p.humanId === person.humanId)
    ? selected.filter((p) => p.humanId !== person.humanId)
    : [...selected, person]
}
