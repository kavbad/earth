/**
 * SCREEN 22 (spec §20–§21): the answer to a relationship action is the newest word on that
 * relationship. `/u/[handle]` seeds the profile query from the server render and the viewer's own
 * `profile_get` follows; when `Add Friend` is pressed inside that window the read is still in
 * flight, carrying `friendRequest: 'none'`. React-query writes a late answer over a cache write,
 * so the recorded request used to disappear behind `Add Friend` again with nothing left to
 * refetch it — the button had to be pressed a second time to stick.
 */
import { fixtures } from '@earth/api/testing'
import { ProfileDtoSchema } from '@earth/domain'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { commitProfile, profileQueryKey } from './useProfile'

const base = ProfileDtoSchema.parse(fixtures.profileDto())
const strangers = {
  ...base,
  relationship: { ...base.relationship, isFriend: false, friendRequest: 'none' as const },
}
const requested = {
  ...strangers,
  relationship: { ...strangers.relationship, friendRequest: 'sent' as const },
}

describe('commitProfile (SCREEN 22)', () => {
  it('holds the relationship answer against a profile_get that was already in flight', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = profileQueryKey(base.identity.handle)
    let answer: () => void = () => undefined
    // The read the viewer's own session started on arrival: it does not observe the abort signal
    // (`profile_get` is a plain POST), so it settles regardless — the whole point of the race.
    const inFlight = client
      .fetchQuery({
        queryKey: key,
        queryFn: async () => {
          await new Promise<void>((resolve) => {
            answer = resolve
          })
          return strangers
        },
      })
      .catch(() => undefined)

    await commitProfile(client, key, requested)
    expect(client.getQueryData(key)).toEqual(requested)

    answer()
    await inFlight
    expect(client.getQueryData(key)).toEqual(requested)
  })

  it('writes the answer when nothing else is reading', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = profileQueryKey(base.identity.handle)
    client.setQueryData(key, strangers)
    await commitProfile(client, key, requested)
    expect(client.getQueryData(key)).toEqual(requested)
  })
})
