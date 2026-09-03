'use client'

/**
 * SCREEN 09 — New chat. Search Humans already on Earth, recent people, pick one for a DM or two
 * or more for a group conversation, then open the composer. No forced group name.
 */
import type { HumanId, SearchPersonDto } from '@earth/domain'
import { asHumanId } from '@earth/domain'
import { copy, formatHandle, mutualLine } from '@earth/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'

import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useEarth } from '../../lib/providers/RuntimeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { TAB_ROUTES } from '../../lib/routes'
import { type KeyValueStorage, localStore, readJson, writeJson } from '../../lib/storage'
import { PageContainer } from '../shell/PageContainer'
import { ScreenHeader } from '../shell/ScreenHeader'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { List, ListRow } from '../ui/ListRow'
import { Spinner } from '../ui/Spinner'
import { ClaimToChat } from './ChatsList'
import { chatCopy } from './copy'
import { useConversationsList } from './hooks/useConversationsList'
import { conversationRoute } from './routes'

export const SEARCH_DEBOUNCE_MS = 250
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

export function readRecentPeople(store: KeyValueStorage | null, viewerId: string): Person[] {
  const parsed = readJson(store, recentPeopleKey(viewerId), (value) =>
    z.array(PersonSchema).safeParse(value).success ? (value as Person[]) : null,
  )
  return (parsed ?? []).map((person) => ({ ...person, humanId: asHumanId(person.humanId) }))
}

export function rememberRecentPeople(
  store: KeyValueStorage | null,
  viewerId: string,
  people: readonly Person[],
): void {
  const existing = readRecentPeople(store, viewerId)
  const merged = [
    ...people,
    ...existing.filter((p) => !people.some((n) => n.humanId === p.humanId)),
  ]
  writeJson(store, recentPeopleKey(viewerId), merged.slice(0, RECENT_PEOPLE_MAX))
}

function personFromSearch(result: SearchPersonDto): Person {
  return {
    humanId: result.humanId,
    displayName: result.displayName,
    handle: result.handle,
    avatarUrl: result.avatarUrl,
  }
}

export function NewChat() {
  const earth = useEarth()
  const session = useSession()
  const analytics = useAnalytics()
  const router = useRouter()
  const list = useConversationsList()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly SearchPersonDto[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<readonly Person[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isHuman = session.status === 'ready' && session.roleKind === 'human'
  const viewerId = session.humanId

  // Recent people: who last wrote in recent conversations, plus people picked here before.
  const recent = useMemo<Person[]>(() => {
    if (viewerId === null) return []
    const seen = new Set<string>()
    const people: Person[] = []
    for (const person of readRecentPeople(localStore(), viewerId)) {
      if (seen.has(person.humanId)) continue
      seen.add(person.humanId)
      people.push(person)
    }
    for (const conversation of list.conversations) {
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
  }, [list.conversations, viewerId])

  const onQueryChange = (value: string) => {
    setQuery(value)
    const empty = value.trim().length === 0
    setSearching(!empty)
    if (empty) setResults(null)
  }

  useEffect(() => {
    const q = query.trim()
    if (!isHuman || q.length === 0) return
    let cancelled = false
    const timer = setTimeout(() => {
      earth.search
        .query(q)
        .then((found) => {
          if (cancelled) return
          setResults(found.people)
          analytics.track('search_performed', {
            queryLength: q.length,
            resultCount: found.people.length,
          })
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, isHuman, earth, analytics])

  const isSelected = (humanId: HumanId) => selected.some((person) => person.humanId === humanId)
  const toggle = (person: Person) => {
    setError(null)
    setSelected((current) =>
      current.some((p) => p.humanId === person.humanId)
        ? current.filter((p) => p.humanId !== person.humanId)
        : [...current, person],
    )
  }

  const start = async () => {
    if (selected.length === 0 || viewerId === null) return
    setCreating(true)
    setError(null)
    try {
      const conversation = await earth.conversations.create({
        humanIds: selected.map((person) => person.humanId),
      })
      rememberRecentPeople(localStore(), viewerId, selected)
      router.push(conversationRoute(conversation.id))
    } catch {
      setError(webCopy.somethingWrong)
      setCreating(false)
    }
  }

  const shown: readonly Person[] =
    results === null
      ? recent.filter((person) => !isSelected(person.humanId))
      : results.map(personFromSearch)

  return (
    <>
      <ScreenHeader
        title={copy.newChat}
        leading={
          <Link
            href={TAB_ROUTES.chats}
            aria-label={webCopy.back}
            className="flex size-touch-target items-center justify-center rounded-avatar text-text-primary hover:bg-subtle-fill"
          >
            <Icon name="back" />
          </Link>
        }
      >
        {isHuman ? (
          <label className="relative block">
            <span className="sr-only">{chatCopy.searchPeople}</span>
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-secondary">
              <Icon name="search" size="small" />
            </span>
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={chatCopy.searchPeople}
              autoComplete="off"
              autoFocus
              className="min-h-10 w-full rounded-medium bg-subtle-fill py-2 pr-4 pl-9 text-body text-text-primary placeholder:text-text-secondary"
            />
          </label>
        ) : null}
      </ScreenHeader>
      <PageContainer className="flex flex-1 flex-col">
        {session.status === 'loading' ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : !isHuman ? (
          <ClaimToChat title={copy.newChat} />
        ) : (
          <>
            {selected.length > 0 ? (
              <div
                className="flex flex-wrap gap-2 px-screen-margin py-3"
                aria-label={chatCopy.selected}
              >
                {selected.map((person) => (
                  <button
                    key={person.humanId}
                    type="button"
                    onClick={() => toggle(person)}
                    aria-label={chatCopy.removeFromSelection(person.displayName)}
                    className="inline-flex min-h-8 items-center gap-1.5 rounded-avatar bg-subtle-fill py-1 pr-2 pl-1 text-secondary text-text-primary"
                  >
                    <Avatar
                      name={person.displayName}
                      src={person.avatarUrl}
                      size="small"
                      decorative
                      className="!size-6"
                    />
                    <span>{person.displayName}</span>
                    <Icon name="close" size="small" />
                  </button>
                ))}
              </div>
            ) : null}
            {results === null && shown.length > 0 ? (
              <p className="px-screen-margin pt-3 pb-1 text-meta text-text-secondary">
                {chatCopy.recent}
              </p>
            ) : null}
            {searching ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : results !== null && shown.length === 0 ? (
              <EmptyState title={chatCopy.noPeopleFound} />
            ) : (
              <List>
                {shown.map((person) => {
                  const detail =
                    results !== null
                      ? mutualLine(
                          results.find((r) => r.humanId === person.humanId)?.mutualFriendCount ?? 0,
                          results.find((r) => r.humanId === person.humanId)?.cityName,
                        )
                      : ''
                  const picked = isSelected(person.humanId)
                  return (
                    <ListRow
                      key={person.humanId}
                      as="button"
                      onClick={() => toggle(person)}
                      aria-pressed={picked}
                      leading={
                        <Avatar name={person.displayName} src={person.avatarUrl} decorative />
                      }
                      title={person.displayName}
                      subtitle={
                        detail.length > 0
                          ? detail
                          : person.handle === null
                            ? undefined
                            : formatHandle(person.handle)
                      }
                      trailing={
                        picked ? <Icon name="check" title={chatCopy.selected} /> : undefined
                      }
                    />
                  )
                })}
              </List>
            )}
            <div className="sticky bottom-[calc(var(--earth-space-16)+env(safe-area-inset-bottom))] mt-auto bg-background px-screen-margin py-3 hairline-t rail:bottom-0">
              {error !== null ? (
                <p role="alert" className="pb-2 text-secondary text-danger">
                  {error}
                </p>
              ) : null}
              <Button
                variant="primary"
                fullWidth
                disabled={selected.length === 0}
                loading={creating}
                onClick={() => void start()}
              >
                {selected.length === 1 ? copy.profileActions.message : chatCopy.startChat}
              </Button>
            </div>
          </>
        )}
      </PageContainer>
    </>
  )
}
