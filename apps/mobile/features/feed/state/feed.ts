/**
 * Pure Home feed state (SCREEN 01–05; spec §70, §110): the react-query key per radius (the
 * per-scope cache), page merging with a stable dedupe (a keyset cursor may overlap on refresh),
 * the split into the presence row and the content cards, the list rows FlatList renders, the
 * once-per-card impression bookkeeping, and the small UI reducer that follows the person across
 * radii — hidden posts and the chosen City. Whether a refresh failed while cached cards stay on
 * screen (spec §110) is read straight from the query: cached data plus an error.
 */
import type { FeedOpenSource } from '@earth/analytics'
import type {
  AreaId,
  FeedCardDto,
  FeedPageDto,
  FeedPostCardDto,
  HumanContextDto,
  LiveCardDto,
  PresenceItemDto,
  Scope,
  ViewerRelation,
} from '@earth/domain'

import { conversationRoute, roomRoute } from '../routes'

export const FEED_QUERY_KEY = 'feed' as const

/** Visitors share one cache; Humans get their own so a sign-in never shows another person's feed. */
export type FeedViewerKey = string

export const VISITOR_KEY: FeedViewerKey = 'visitor'

export function viewerKeyFor(humanId: string | null): FeedViewerKey {
  return humanId ?? VISITOR_KEY
}

export function feedQueryKey(
  scope: Scope,
  areaId: AreaId | null,
  viewerKey: FeedViewerKey,
): readonly [typeof FEED_QUERY_KEY, FeedViewerKey, Scope, AreaId | null] {
  return [FEED_QUERY_KEY, viewerKey, scope, areaId]
}

/** Cards of every page in order, each id once (the first occurrence wins). */
export function mergeFeedPages(pages: readonly FeedPageDto[]): FeedCardDto[] {
  const seen = new Set<string>()
  const cards: FeedCardDto[] = []
  for (const page of pages) {
    for (const card of page.cards) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      cards.push(card)
    }
  }
  return cards
}

export type FeedContentCard = FeedPostCardDto | LiveCardDto

export interface FeedView {
  /** Presence items of every presence card, in order (SCREEN 02: render only when non-empty). */
  readonly presence: readonly PresenceItemDto[]
  readonly cards: readonly FeedContentCard[]
  /** "North Beach", the current City — from the first page (SCREEN 03/04). */
  readonly areaName: string | null
}

export const EMPTY_FEED_VIEW: FeedView = { presence: [], cards: [], areaName: null }

/** Splits merged cards into the presence row and the content list, dropping hidden posts. */
export function feedView(
  pages: readonly FeedPageDto[],
  hiddenPostIds: ReadonlySet<string> = new Set(),
): FeedView {
  if (pages.length === 0) return EMPTY_FEED_VIEW
  const presence: PresenceItemDto[] = []
  const cards: FeedContentCard[] = []
  for (const card of mergeFeedPages(pages)) {
    if (card.kind === 'presence') {
      presence.push(...card.items)
      continue
    }
    if (card.kind === 'post' && hiddenPostIds.has(card.id)) continue
    cards.push(card)
  }
  return { presence, cards, areaName: pages[0]?.areaName ?? null }
}

// ---------------------------------------------------------------------------
// List rows (what FlatList renders) and impressions
// ---------------------------------------------------------------------------

export interface FeedRow {
  /** Stable key for FlatList (`post:<id>` / `live:<id>`). */
  readonly key: string
  readonly card: FeedContentCard
  /** Position in the list, for `post_impression` / `live_card_impression`. */
  readonly position: number
}

export function feedRowKey(card: FeedContentCard): string {
  return `${card.kind}:${card.id}`
}

/** The content cards as list rows with their positions. */
export function feedRows(cards: readonly FeedContentCard[]): FeedRow[] {
  return cards.map((card, position) => ({ key: feedRowKey(card), card, position }))
}

/** `self` for the viewer's own posts, `other` for everyone else (feeds carry no relation). */
export function authorRelationFor(viewerId: string | null, authorHumanId: string): ViewerRelation {
  return viewerId !== null && viewerId === authorHumanId ? 'self' : 'other'
}

/**
 * Impressions are reported once per card (spec §97): given the keys already reported and the
 * keys now at least half visible, the keys to report now. Pure so the bookkeeping is tested.
 */
export function newlySeenKeys(
  seen: ReadonlySet<string>,
  visible: readonly string[],
): readonly string[] {
  const out: string[] = []
  for (const key of visible) {
    if (seen.has(key) || out.includes(key)) continue
    out.push(key)
  }
  return out
}

// ---------------------------------------------------------------------------
// UI state that follows the person across radii
// ---------------------------------------------------------------------------

export interface FeedUiState {
  readonly viewerKey: FeedViewerKey
  /** Posts hidden on this device in this session; the server excludes them from later pages. */
  readonly hiddenPostIds: readonly string[]
  /** The City chosen in the City radius (`null` = the server's current city, SCREEN 04). */
  readonly cityAreaId: AreaId | null
}

export type FeedUiAction =
  | { readonly type: 'hide'; readonly postId: string }
  | { readonly type: 'unhide'; readonly postId: string }
  | { readonly type: 'select_city'; readonly areaId: AreaId | null }
  | { readonly type: 'viewer_changed'; readonly viewerKey: FeedViewerKey }

export function initialFeedUiState(viewerKey: FeedViewerKey): FeedUiState {
  return { viewerKey, hiddenPostIds: [], cityAreaId: null }
}

export function feedUiReducer(state: FeedUiState, action: FeedUiAction): FeedUiState {
  switch (action.type) {
    case 'hide':
      return state.hiddenPostIds.includes(action.postId)
        ? state
        : { ...state, hiddenPostIds: [...state.hiddenPostIds, action.postId] }
    case 'unhide':
      return state.hiddenPostIds.includes(action.postId)
        ? { ...state, hiddenPostIds: state.hiddenPostIds.filter((id) => id !== action.postId) }
        : state
    case 'select_city':
      return state.cityAreaId === action.areaId ? state : { ...state, cityAreaId: action.areaId }
    case 'viewer_changed':
      // A different person: nothing hidden or chosen carries over.
      return state.viewerKey === action.viewerKey ? state : initialFeedUiState(action.viewerKey)
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown feed action: ${String(exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// City switch (SCREEN 04: current city and home city only in V1)
// ---------------------------------------------------------------------------

export const CITY_CHOICE_KINDS = ['current', 'home'] as const
export type CityChoiceKind = (typeof CITY_CHOICE_KINDS)[number]

export interface CityChoice {
  readonly kind: CityChoiceKind
  readonly areaId: AreaId
  readonly name: string
}

/**
 * The cities a Human may browse: where they are now (from `human_context`) and their home city
 * (name resolved separately). The same city is offered once, as `current`.
 */
export function cityChoices(
  context: HumanContextDto | null,
  homeCityName: string | null,
): readonly CityChoice[] {
  if (context === null) return []
  const choices: CityChoice[] = []
  if (context.currentCityId !== null && context.currentCityName !== null) {
    choices.push({ kind: 'current', areaId: context.currentCityId, name: context.currentCityName })
  }
  if (
    context.homeCityId !== null &&
    homeCityName !== null &&
    context.homeCityId !== context.currentCityId
  ) {
    choices.push({ kind: 'home', areaId: context.homeCityId, name: homeCityName })
  }
  return choices
}

export function selectedCityChoice(
  choices: readonly CityChoice[],
  selected: AreaId | null,
): CityChoice | undefined {
  return selected === null
    ? (choices.find((choice) => choice.kind === 'current') ?? choices[0])
    : choices.find((choice) => choice.areaId === selected)
}

/** The area passed to `feed.page` for a radius: only City honours an explicit choice. */
export function areaIdForScope(scope: Scope, cityAreaId: AreaId | null): AreaId | null {
  return scope === 'city' ? cityAreaId : null
}

/**
 * The header subtitle (SCREEN 03/04): the neighborhood name in Neighborhood; the city name in
 * City when there is no switch to show (fewer than two choices); nothing otherwise.
 */
export function feedSubtitle(input: {
  readonly scope: Scope
  readonly areaName: string | null
  readonly context: HumanContextDto | null
  readonly choiceCount: number
}): string | undefined {
  if (input.scope === 'neighborhood') {
    return input.areaName ?? input.context?.currentAreaName ?? undefined
  }
  if (input.scope === 'city' && input.choiceCount < 2) {
    return input.areaName ?? input.context?.currentCityName ?? undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Analytics helpers (spec §97 `feed_opened`)
// ---------------------------------------------------------------------------

/** First open of the session is `launch`; later opens come from the tab or a manual refresh. */
export function feedOpenSource(hasOpenedBefore: boolean, manualRefresh: boolean): FeedOpenSource {
  if (manualRefresh) return 'refresh'
  return hasOpenedBefore ? 'tab' : 'launch'
}

// ---------------------------------------------------------------------------
// Presence row (SCREEN 02)
// ---------------------------------------------------------------------------

/** Where a presence item leads: its room, its conversation, or nowhere (informational). */
export function presenceHref(item: PresenceItemDto): string | null {
  if (item.roomId !== null) return roomRoute(item.roomId)
  if (item.conversationId !== null) return conversationRoute(item.conversationId)
  return null
}

/**
 * The zero-friends member state (SCREEN 02): a Human with no friends browsing Friends sees the
 * contextual "Add people you actually know" row — never a takeover, never for Visitors.
 */
export function shouldShowAddPeople(input: {
  readonly isHuman: boolean
  readonly scope: Scope
  readonly friendCount: number | null
}): boolean {
  return input.isHuman && input.scope === 'friends' && input.friendCount === 0
}
