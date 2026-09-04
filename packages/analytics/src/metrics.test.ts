import { describe, expect, it } from 'vitest'

import { EVENT_NAMES } from './contract'
import {
  eventsUsedByMetrics,
  FIRST_PARTY_METRIC_KEYS,
  FIRST_PARTY_METRICS,
  METRIC_SECTIONS,
  metricsInSection,
} from './metrics'

describe('FIRST_PARTY_METRICS', () => {
  it('covers every metric named in spec §98–§101', () => {
    expect(metricsInSection('acquisition')).toEqual([
      'group_seed_rate',
      'humans_per_seed',
      'group_activation_rate',
      'group_migration_depth',
      'second_group_rate',
    ])
    expect(metricsInSection('messenger')).toEqual([
      'messages_per_active_group',
      'group_messaging_retention_d1',
      'group_messaging_retention_d7',
      'group_messaging_retention_d30',
      'groups_messaging_three_days_weekly',
      'message_delivery_latency_p50',
      'failed_message_rate',
    ])
    expect(metricsInSection('live')).toEqual([
      'active_groups_starting_video',
      'active_groups_live_beyond_group',
      'live_notification_ctr',
      'viewer_to_audio_rate',
      'viewer_to_camera_rate',
      'average_room_participants',
      'repeat_live_participants',
      'guest_joins',
      'repeat_guests',
      'guest_to_human_conversion',
    ])
    expect(metricsInSection('feed')).toEqual([
      'feed_return_rate',
      'friends_feed_usage',
      'world_usage',
      'radius_switching',
      'relevant_hide_rate',
      'meaningful_actions',
      'public_live_discovery',
    ])
    expect(FIRST_PARTY_METRIC_KEYS).toHaveLength(29)
  })

  it('every metric names contract events, a section, a cadence and a description', () => {
    for (const key of FIRST_PARTY_METRIC_KEYS) {
      const metric = FIRST_PARTY_METRICS[key]
      expect(METRIC_SECTIONS, key).toContain(metric.section)
      expect(metric.cadence.length, key).toBeGreaterThan(0)
      expect(metric.description.length, key).toBeGreaterThan(10)
      expect(metric.events.length, key).toBeGreaterThan(0)
      for (const event of metric.events) expect(EVENT_NAMES, `${key} → ${event}`).toContain(event)
    }
  })

  it('reports the set of events the metrics job depends on', () => {
    const used = eventsUsedByMetrics()
    expect(used.has('message_sent')).toBe(true)
    expect(used.has('guest_joined')).toBe(true)
    expect(used.size).toBeGreaterThan(20)
  })
})
