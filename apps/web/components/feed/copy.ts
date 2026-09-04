/**
 * Home, notifications and search microcopy for moments the spec leaves unnamed. Everything the
 * spec quotes (the wordmark, `Add people you actually know`, the presence lines, `Couldn't
 * refresh`, the section names, the notification titles) comes from `@earth/ui` and is never
 * restated here.
 */
import type { Scope } from '@earth/domain'

export const feedCopy = {
  // SCREEN 01–05 Home
  nothingHereYet: (scope: Scope): string =>
    scope === 'friends' ? 'Nothing from your people yet.' : 'Nothing here yet.',
  publicWorldOff: 'Public World is not open yet.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  endOfFeed: "That's everything for now.",
  loadingMore: 'Loading more',
  composeEntry: 'Say something',
  newPost: 'New post',
  presenceLabel: 'Right now',
  addPeopleBody: 'Find people by name or handle.',
  findPeople: 'Find people',
  cityTitle: 'City',
  currentCity: 'Where you are',
  homeCity: 'Home city',
  changeCity: 'Change city',
  noCityYet: 'No city yet.',
  feedList: 'Feed',
  nearbyHidden: 'Only what people chose to share.',
  openSearch: 'Search',

  // SCREEN 23 notifications
  nothingYet: 'Nothing yet.',
  unread: 'Unread',
  unreadCount: (count: number): string => (count === 1 ? '1 unread' : `${count} unread`),
  accept: 'Accept',
  notificationsFor: 'Notifications are for people on Earth.',

  // SCREEN 21 search
  searchPlaceholder: 'Search Earth',
  searchLabel: 'Search',
  noResults: (query: string): string => `Nothing for “${query}”.`,
  members: (count: number): string => (count === 1 ? '1 member' : `${count} members`),
  member: 'Member',
  groupFallback: 'Group',
  friend: 'Friend',
  following: 'Following',
  searchHint: 'People, groups, places and posts.',
} as const

export type FeedCopy = typeof feedCopy
