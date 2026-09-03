'use client'

/**
 * SCREEN 21 — one universal input; sections People, Groups, Places, Posts in the server's order.
 * People read "Xavier — 8 mutual friends · San Francisco". Visitors search people and places.
 */
import type { SearchGroupDto, SearchPersonDto, SearchPlaceDto } from '@earth/domain'
import { copy, formatHandle, mutualLine } from '@earth/ui'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { type ReactNode, useState } from 'react'

import { webCopy } from '../../../lib/copy'
import { conversationRoute } from '../../../lib/routes'
import { useEarth } from '../../../lib/providers/RuntimeProvider'
import { earthPlaceRoute } from '../../chats/routes'
import { PostCard } from '../../posts/PostCard'
import { profileRoute, SEARCH_QUERY_PARAM } from '../../profile/routes'
import { PageContainer } from '../../shell/PageContainer'
import { ScreenHeader } from '../../shell/ScreenHeader'
import { Avatar } from '../../ui/Avatar'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { List, ListRow } from '../../ui/ListRow'
import { Spinner } from '../../ui/Spinner'
import { useToast } from '../../ui/Toast'
import { feedCopy } from '../copy'
import { useSearch } from './useSearch'

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col">
      <h2 className="px-screen-margin pt-4 pb-1 text-section">{title}</h2>
      {children}
    </section>
  )
}

const LINK_ROW_CLASS =
  'flex w-full min-h-touch-target items-center gap-3 px-screen-margin py-2 text-left text-body text-text-primary transition-colors duration-fast ease-standard hover:bg-subtle-fill'

function PersonRow({ person }: { readonly person: SearchPersonDto }) {
  const detail = mutualLine(person.mutualFriendCount, person.cityName)
  return (
    <Link
      href={profileRoute(person.handle)}
      className={LINK_ROW_CLASS}
      aria-label={copy.searchPersonLine(person.displayName, detail)}
    >
      <Avatar name={person.displayName} src={person.avatarUrl} decorative />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{person.displayName}</span>
        <span className="truncate text-secondary text-text-secondary">
          {detail !== '' ? detail : formatHandle(person.handle)}
        </span>
      </span>
      {person.isFriend || person.isFollowing ? (
        <span className="shrink-0 text-secondary text-text-secondary">
          {person.isFriend ? feedCopy.friend : feedCopy.following}
        </span>
      ) : null}
    </Link>
  )
}

function GroupRow({ group }: { readonly group: SearchGroupDto }) {
  const earth = useEarth()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const name = group.name ?? feedCopy.groupFallback
  const subtitle = feedCopy.members(group.memberCount)
  const open = async () => {
    setBusy(true)
    try {
      const detail = await earth.groups.get(group.groupId)
      router.push(conversationRoute(detail.conversationId))
    } catch {
      toast.show(webCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }
  if (!group.isMember) {
    return (
      <ListRow
        leading={<Avatar name={name} src={group.avatarUrl} decorative />}
        title={name}
        subtitle={subtitle}
      />
    )
  }
  return (
    <ListRow
      as="button"
      onClick={() => void open()}
      disabled={busy}
      leading={<Avatar name={name} src={group.avatarUrl} decorative />}
      title={name}
      subtitle={subtitle}
      trailing={feedCopy.member}
    />
  )
}

function PlaceRow({ place }: { readonly place: SearchPlaceDto }) {
  return (
    <Link href={earthPlaceRoute(place.placeId)} className={LINK_ROW_CLASS}>
      <Icon name="location" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{place.name}</span>
        {place.areaName !== null ? (
          <span className="truncate text-secondary text-text-secondary">{place.areaName}</span>
        ) : null}
      </span>
    </Link>
  )
}

export function SearchScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const [input, setInput] = useState(() => params.get(SEARCH_QUERY_PARAM) ?? '')
  const search = useSearch(input)
  const results = search.results
  const empty =
    results !== undefined &&
    results.people.length + results.groups.length + results.places.length + results.posts.length ===
      0
  const back = () => router.back()

  return (
    <>
      <ScreenHeader
        title={copy.search}
        leading={
          <button
            type="button"
            onClick={back}
            aria-label={webCopy.back}
            className="flex size-touch-target items-center justify-center rounded-avatar text-text-primary hover:bg-subtle-fill"
          >
            <Icon name="back" />
          </button>
        }
      >
        <label className="relative block">
          <span className="sr-only">{feedCopy.searchLabel}</span>
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-secondary">
            <Icon name="search" size="small" />
          </span>
          <input
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={feedCopy.searchPlaceholder}
            autoComplete="off"
            autoFocus
            enterKeyHint="search"
            className="min-h-touch-target w-full rounded-medium bg-subtle-fill py-2 pr-4 pl-9 text-body text-text-primary placeholder:text-text-secondary"
          />
        </label>
      </ScreenHeader>
      <PageContainer>
        {search.query === '' ? (
          <p className="px-screen-margin py-4 text-secondary text-text-secondary">
            {feedCopy.searchHint}
          </p>
        ) : search.searching ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : search.failed ? (
          <p role="status" className="px-screen-margin py-4 text-secondary text-text-secondary">
            {copy.couldntRefresh}
          </p>
        ) : results === undefined ? null : empty ? (
          <EmptyState title={feedCopy.noResults(search.query)} />
        ) : (
          <div className="fade-in flex flex-col pb-6" key={search.query}>
            {results.people.length > 0 ? (
              <Section title={copy.searchSections.people}>
                <List>
                  {results.people.map((person) => (
                    <PersonRow key={person.humanId} person={person} />
                  ))}
                </List>
              </Section>
            ) : null}
            {results.groups.length > 0 ? (
              <Section title={copy.searchSections.groups}>
                <List>
                  {results.groups.map((group) => (
                    <GroupRow key={group.groupId} group={group} />
                  ))}
                </List>
              </Section>
            ) : null}
            {results.places.length > 0 ? (
              <Section title={copy.searchSections.places}>
                <List>
                  {results.places.map((place) => (
                    <PlaceRow key={place.placeId} place={place} />
                  ))}
                </List>
              </Section>
            ) : null}
            {results.posts.length > 0 ? (
              <Section title={copy.searchSections.posts}>
                <ol className="flex flex-col [&>*+*]:hairline-t">
                  {results.posts.map((view) => (
                    <li key={view.post.id}>
                      <PostCard view={view} context={{ source: 'search' }} />
                    </li>
                  ))}
                </ol>
              </Section>
            ) : null}
          </div>
        )}
      </PageContainer>
    </>
  )
}
