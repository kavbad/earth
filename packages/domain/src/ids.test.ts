import { describe, expect, it } from 'vitest'

import { EarthError } from './errors'
import {
  asGroupId,
  asGuestSessionId,
  asHumanId,
  asRoomId,
  HumanIdSchema,
  isUuid,
  MediaIdentitySchema,
  mediaIdentityForGuest,
  mediaIdentityForHuman,
  parseMediaIdentity,
} from './ids'

const HUMAN = '11111111-1111-4111-8111-111111111111'
const GUEST = '22222222-2222-4222-8222-222222222222'

describe('branded ids', () => {
  it('validates uuids', () => {
    expect(isUuid(HUMAN)).toBe(true)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid(42)).toBe(false)
    expect(HumanIdSchema.parse(HUMAN)).toBe(HUMAN)
    expect(HumanIdSchema.safeParse('abc').success).toBe(false)
  })

  it('as<Id> helpers return the value and throw EarthError(invalid_input) on garbage', () => {
    expect(asHumanId(HUMAN)).toBe(HUMAN)
    expect(asGroupId(GUEST)).toBe(GUEST)
    expect(asRoomId(HUMAN)).toBe(HUMAN)
    expect(asGuestSessionId(GUEST)).toBe(GUEST)
    let caught: unknown
    try {
      asHumanId('nope')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EarthError)
    expect((caught as EarthError).code).toBe('invalid_input')
    expect((caught as EarthError).details).toEqual({ field: 'HumanId', reason: 'not_a_uuid' })
  })
})

describe('media identity', () => {
  it('formats h:<human_id> and g:<guest_session_id>', () => {
    expect(mediaIdentityForHuman(asHumanId(HUMAN))).toBe(`h:${HUMAN}`)
    expect(mediaIdentityForGuest(asGuestSessionId(GUEST))).toBe(`g:${GUEST}`)
  })

  it('parses back and rejects other prefixes', () => {
    expect(parseMediaIdentity(`h:${HUMAN}`)).toEqual({ kind: 'human', humanId: HUMAN })
    expect(parseMediaIdentity(`g:${GUEST}`)).toEqual({ kind: 'guest', guestSessionId: GUEST })
    expect(parseMediaIdentity(`x:${GUEST}`)).toBeNull()
    expect(parseMediaIdentity('h:nope')).toBeNull()
    expect(MediaIdentitySchema.safeParse(`h:${HUMAN}`).success).toBe(true)
    expect(MediaIdentitySchema.safeParse(`h:${HUMAN}x`).success).toBe(false)
    expect(MediaIdentitySchema.safeParse(HUMAN).success).toBe(false)
  })
})
