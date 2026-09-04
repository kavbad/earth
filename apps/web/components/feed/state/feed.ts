/**
 * Pure Home feed state (SCREEN 01–05; spec §70, §110): the react-query key per radius, page
 * merging with a stable dedupe (a keyset cursor may overlap on refresh), the split into the
 * presence row and the content cards, and the small UI reducer that follows the person across
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
} from '@earth/domain'

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

/**
 * Whether the Home list shows its placeholder instead of a verdict about the radius (spec §92:
 * an empty state only when it is meaningful; §107: never a dead end while nothing is known).
 * The shell builds its runtime in the first client render and resolves the session just after,
 * so a query that has not been allowed to start yet is still a load in progress.
 */
export function feedIsLoading(input: {
  /** The radius is open to this person (not gated by a flag or the claim gate). */
  readonly scopeOpen: boolean
  /** The runtime exists and the session has resolved. */
  readonly shellReady: boolean
  readonly queryPending: boolean
}): boolean {
  return input.scopeOpen && (!input.shellReady || input.queryPending)
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

/** The area passed to `feed.page` for a radius: only City honours an explicit choice. */
export function areaIdForScope(scope: Scope, cityAreaId: AreaId | null): AreaId | null {
  return scope === 'city' ? cityAreaId : null
}

// ---------------------------------------------------------------------------
// Analytics helpers (spec §97 `feed_opened`)
// ---------------------------------------------------------------------------

/** First open of the session is `launch`; later opens come from the tab or a manual refresh. */
export function feedOpenSource(hasOpenedBefore: boolean, manualRefresh: boolean): FeedOpenSource {
  if (manualRefresh) return 'refresh'
  return hasOpenedBefore ? 'tab' : 'launch'
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
