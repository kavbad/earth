/**
 * Search results (SCREEN 21): the four sections — People, Groups, Places, Posts — flattened into
 * the rows one FlatList renders (a header row per non-empty section), and the count
 * `search_performed` reports (never the text, spec §96).
 */
import type {
  PostViewDto,
  SearchGroupDto,
  SearchPersonDto,
  SearchPlaceDto,
  SearchResultsDto,
} from '@earth/domain'

export const SEARCH_SECTIONS = ['people', 'groups', 'places', 'posts'] as const
export type SearchSection = (typeof SEARCH_SECTIONS)[number]

export type SearchRow =
  | { readonly key: string; readonly kind: 'header'; readonly section: SearchSection }
  | { readonly key: string; readonly kind: 'person'; readonly person: SearchPersonDto }
  | { readonly key: string; readonly kind: 'group'; readonly group: SearchGroupDto }
  | { readonly key: string; readonly kind: 'place'; readonly place: SearchPlaceDto }
  | { readonly key: string; readonly kind: 'post'; readonly view: PostViewDto }

export function resultCount(results: SearchResultsDto): number {
  return (
    results.people.length + results.groups.length + results.places.length + results.posts.length
  )
}

/** Sections in the spec's order, each with a header, only when it has results. */
export function searchRows(results: SearchResultsDto): readonly SearchRow[] {
  const rows: SearchRow[] = []
  if (results.people.length > 0) {
    rows.push({ key: 'header:people', kind: 'header', section: 'people' })
    for (const person of results.people) {
      rows.push({ key: `person:${person.humanId}`, kind: 'person', person })
    }
  }
  if (results.groups.length > 0) {
    rows.push({ key: 'header:groups', kind: 'header', section: 'groups' })
    for (const group of results.groups)
      rows.push({ key: `group:${group.groupId}`, kind: 'group', group })
  }
  if (results.places.length > 0) {
    rows.push({ key: 'header:places', kind: 'header', section: 'places' })
    for (const place of results.places)
      rows.push({ key: `place:${place.placeId}`, kind: 'place', place })
  }
  if (results.posts.length > 0) {
    rows.push({ key: 'header:posts', kind: 'header', section: 'posts' })
    for (const view of results.posts) rows.push({ key: `post:${view.post.id}`, kind: 'post', view })
  }
  return rows
}
