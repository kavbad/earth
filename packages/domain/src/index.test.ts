import { describe, expect, it } from 'vitest'

import * as domain from './index'

describe('@earth/domain', () => {
  it('exposes its package name', () => {
    expect(domain.PACKAGE_NAME).toBe('@earth/domain')
  })

  it('re-exports the core modules from the single entry point', () => {
    expect(domain.ENUM_REGISTRY.human_status).toContain('active')
    expect(domain.EARTH_ERROR_CODES).toContain('consent_required')
    expect(domain.isAudienceWithin('friends', 'world')).toBe(true)
    expect(domain.suggestHandle('Maya')).toBe('maya')
    expect(domain.ROOM_GRACE_SECONDS_DEFAULT).toBe(120)
    expect(domain.ROOM_ACTIVITY_REGISTRY).toEqual({})
    expect(domain.V1_IDENTITY_KIND).toBe('human')
    expect(domain.COMMERCIAL_OBJECT_KINDS.length).toBeGreaterThan(0)
    expect(domain.RoomDtoSchema).toBeDefined()
    expect(domain.FeedPageDtoSchema).toBeDefined()
  })
})
