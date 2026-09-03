/**
 * Mission-critical first-party metrics (EARTH_V1_SPEC.md PART XVII §98–§101; §13 "persist the
 * handful of mission-critical network metrics in first-party database tables/jobs").
 *
 * Each entry names the contract events it derives from so the daily metrics job
 * (`POST /api/internal/metrics/daily` → `metrics_compute_daily`) and the docs share one list.
 * Where the canonical source is a database table rather than events, `source` says so.
 */
import type { EventName } from './contract'

export const METRIC_SECTIONS = ['acquisition', 'messenger', 'live', 'feed'] as const
export type MetricSection = (typeof METRIC_SECTIONS)[number]

export const METRIC_CADENCES = ['daily', 'weekly'] as const
export type MetricCadence = (typeof METRIC_CADENCES)[number]

export const METRIC_UNITS = ['count', 'ratio', 'ms'] as const
export type MetricUnit = (typeof METRIC_UNITS)[number]

export const METRIC_SOURCES = ['events', 'tables', 'events_and_tables'] as const
export type MetricSource = (typeof METRIC_SOURCES)[number]

export interface FirstPartyMetric {
  readonly name: string
  readonly section: MetricSection
  readonly cadence: readonly MetricCadence[]
  readonly unit: MetricUnit
  readonly source: MetricSource
  readonly description: string
  readonly events: readonly EventName[]
}

const DAILY_WEEKLY = ['daily', 'weekly'] as const

export const FIRST_PARTY_METRICS = {
  // §98 Core acquisition
  group_seed_rate: {
    name: 'Group Seed Rate',
    section: 'acquisition',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'events',
    description: 'Humans who start or join a group ÷ Visitors who showed claim intent.',
    events: ['claim_started', 'human_claimed', 'group_created', 'group_joined'],
  },
  humans_per_seed: {
    name: 'Humans per Seed',
    section: 'acquisition',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events_and_tables',
    description: 'Average Humans a created group brings in.',
    events: ['group_created', 'group_joined'],
  },
  group_activation_rate: {
    name: 'Group Activation Rate',
    section: 'acquisition',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'tables',
    description: 'Created groups reaching ≥ 3 active Humans.',
    events: ['group_created', 'group_joined'],
  },
  group_migration_depth: {
    name: 'Group Migration Depth',
    section: 'acquisition',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'events_and_tables',
    description: 'Joined Humans ÷ estimated invited members (invite max_uses / opens).',
    events: ['group_invite_shared', 'group_invite_opened', 'group_joined'],
  },
  second_group_rate: {
    name: 'Second Group Rate',
    section: 'acquisition',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'events',
    description: 'Share of Humans joining or starting another group within 30 days.',
    events: ['second_group_joined', 'human_claimed'],
  },

  // §99 Messenger
  messages_per_active_group: {
    name: 'Messages per active group',
    section: 'messenger',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events_and_tables',
    description: 'Messages sent ÷ groups with at least one message in the period.',
    events: ['message_sent'],
  },
  group_messaging_retention_d1: {
    name: 'Group messaging retention D1',
    section: 'messenger',
    cadence: ['daily'],
    unit: 'ratio',
    source: 'events_and_tables',
    description: 'Groups messaging again 1 day after their first message.',
    events: ['message_sent', 'group_created'],
  },
  group_messaging_retention_d7: {
    name: 'Group messaging retention D7',
    section: 'messenger',
    cadence: ['daily'],
    unit: 'ratio',
    source: 'events_and_tables',
    description: 'Groups messaging again 7 days after their first message.',
    events: ['message_sent', 'group_created'],
  },
  group_messaging_retention_d30: {
    name: 'Group messaging retention D30',
    section: 'messenger',
    cadence: ['daily'],
    unit: 'ratio',
    source: 'events_and_tables',
    description: 'Groups messaging again 30 days after their first message.',
    events: ['message_sent', 'group_created'],
  },
  groups_messaging_three_days_weekly: {
    name: 'Groups with messages on ≥ 3 days/week',
    section: 'messenger',
    cadence: ['weekly'],
    unit: 'count',
    source: 'events_and_tables',
    description: 'Groups that had messages on at least three distinct days in the week.',
    events: ['message_sent'],
  },
  message_delivery_latency_p50: {
    name: 'Median message delivery latency',
    section: 'messenger',
    cadence: DAILY_WEEKLY,
    unit: 'ms',
    source: 'events',
    description: 'p50 of message_received.deliveryLatencyMs.',
    events: ['message_received'],
  },
  failed_message_rate: {
    name: 'Failed message rate',
    section: 'messenger',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'events',
    description: 'message_sent with outcome=failed ÷ all message_sent.',
    events: ['message_sent'],
  },

  // §100 Live
  active_groups_starting_video: {
    name: 'Active groups starting video',
    section: 'live',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events_and_tables',
    description: 'Active groups whose members created at least one group room.',
    events: ['room_created'],
  },
  active_groups_live_beyond_group: {
    name: 'Active groups going Live beyond private/group',
    section: 'live',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events_and_tables',
    description: 'Groups with a room whose visibility widened past group.',
    events: ['room_visibility_changed'],
  },
  live_notification_ctr: {
    name: 'Live notification CTR',
    section: 'live',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'events_and_tables',
    description: 'live_join_requested from notifications ÷ Live notifications delivered.',
    events: ['live_join_requested'],
  },
  viewer_to_audio_rate: {
    name: 'Viewer → audio',
    section: 'live',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'events',
    description: 'audio_joined from watching ÷ room_joined as watching.',
    events: ['room_joined', 'audio_joined'],
  },
  viewer_to_camera_rate: {
    name: 'Viewer → camera',
    section: 'live',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'events',
    description: 'camera_enabled from watching or audio ÷ room_joined as watching.',
    events: ['room_joined', 'camera_enabled'],
  },
  average_room_participants: {
    name: 'Average room participants',
    section: 'live',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events_and_tables',
    description: 'Mean peak participantCount across rooms that ended in the period.',
    events: ['room_joined', 'room_left'],
  },
  repeat_live_participants: {
    name: 'Repeat Live participants',
    section: 'live',
    cadence: ['weekly'],
    unit: 'count',
    source: 'events',
    description: 'Humans who joined rooms on ≥ 2 distinct days in the period.',
    events: ['room_joined'],
  },
  guest_joins: {
    name: 'Guest joins',
    section: 'live',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events_and_tables',
    description: 'Guest sessions that joined a room.',
    events: ['guest_joined'],
  },
  repeat_guests: {
    name: 'Repeat Guests',
    section: 'live',
    cadence: ['weekly'],
    unit: 'count',
    source: 'events',
    description: 'Anonymous visitor ids with ≥ 2 guest_joined in the period.',
    events: ['guest_joined'],
  },
  guest_to_human_conversion: {
    name: 'Guest → Human conversion',
    section: 'live',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'events_and_tables',
    description: 'human_claimed carrying a guestSessionId ÷ distinct guest sessions.',
    events: ['guest_joined', 'guest_room_completed', 'human_claimed'],
  },

  // §101 Feed
  feed_return_rate: {
    name: 'Feed return',
    section: 'feed',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'events',
    description: 'Humans opening the feed on ≥ 2 distinct days ÷ Humans opening it at all.',
    events: ['feed_opened'],
  },
  friends_feed_usage: {
    name: 'Friends feed usage',
    section: 'feed',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events',
    description: 'feed_opened with scope=friends.',
    events: ['feed_opened', 'scope_changed'],
  },
  world_usage: {
    name: 'World usage',
    section: 'feed',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events',
    description: 'feed_opened / public_world_viewed with scope=world.',
    events: ['feed_opened', 'public_world_viewed', 'scope_changed'],
  },
  radius_switching: {
    name: 'Radius switching',
    section: 'feed',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events',
    description: 'scope_changed per active Human.',
    events: ['scope_changed'],
  },
  relevant_hide_rate: {
    name: 'Relevant hide rate',
    section: 'feed',
    cadence: DAILY_WEEKLY,
    unit: 'ratio',
    source: 'events',
    description: 'post_hidden ÷ post_impression, by scope.',
    events: ['post_impression', 'post_hidden'],
  },
  meaningful_actions: {
    name: 'Meaningful reply / follow / friend actions',
    section: 'feed',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events',
    description: 'post_replied + follow_created + friend_requested originating from the feed.',
    events: ['post_replied', 'follow_created', 'friend_requested'],
  },
  public_live_discovery: {
    name: 'Public Live discovery',
    section: 'feed',
    cadence: DAILY_WEEKLY,
    unit: 'count',
    source: 'events',
    description: 'live_card_opened / live_join_requested on world or city scope.',
    events: ['live_card_impression', 'live_card_opened', 'live_join_requested'],
  },
} as const satisfies Record<string, FirstPartyMetric>

export type FirstPartyMetricKey = keyof typeof FIRST_PARTY_METRICS
export const FIRST_PARTY_METRIC_KEYS = Object.keys(
  FIRST_PARTY_METRICS,
) as readonly FirstPartyMetricKey[]

export function metricsInSection(section: MetricSection): readonly FirstPartyMetricKey[] {
  return FIRST_PARTY_METRIC_KEYS.filter((key) => FIRST_PARTY_METRICS[key].section === section)
}

/** Every event at least one metric depends on. */
export function eventsUsedByMetrics(): ReadonlySet<EventName> {
  const used = new Set<EventName>()
  for (const key of FIRST_PARTY_METRIC_KEYS) {
    for (const event of FIRST_PARTY_METRICS[key].events) used.add(event)
  }
  return used
}
