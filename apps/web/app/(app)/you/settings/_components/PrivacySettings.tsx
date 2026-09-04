'use client'

/**
 * SCREEN 25 → Privacy: profile visibility and city, the default post audience, Live defaults
 * (remembered on this device until a server preference exists) and location — home city plus
 * the way to what you are sharing on Earth.
 */
import {
  AUDIENCE,
  type AreaDto,
  PROFILE_VISIBILITY,
  type ProfileVisibility,
  asAreaId,
} from '@earth/domain'
import { copy } from '@earth/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { earthRoute } from '../../../../../components/map/routes'
import { Button } from '../../../../../components/ui/Button'
import { List, ListRow } from '../../../../../components/ui/ListRow'
import { SegmentedText } from '../../../../../components/ui/SegmentedText'
import { TextField } from '../../../../../components/ui/TextField'
import { useToast } from '../../../../../components/ui/Toast'
import { webCopy } from '../../../../../lib/copy'
import { useEarth, useRuntime } from '../../../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../../../lib/providers/SessionProvider'
import { localStore } from '../../../../../lib/storage'
import { youCopy } from '../../_lib/copy'
import {
  DEFAULT_AUDIENCE,
  LIVE_DEFAULTS_FALLBACK,
  LIVE_JOIN_POLICY_CHOICES,
  LIVE_VISIBILITY_CHOICES,
  type LiveDefaults,
  readDefaultAudience,
  readLiveDefaults,
  writeDefaultAudience,
  writeLiveDefaults,
} from '../../_lib/prefs'
import { SettingsSection } from './SettingsFrame'

const items = copy.settings.sections.privacy.items

export const AREA_SEARCH_DEBOUNCE_MS = 300

export function PrivacySettings() {
  const session = useSession()
  const humanId = session.humanId
  const identity = session.identity
  if (identity === null || humanId === null) return null
  return (
    <>
      <ProfilePrivacy
        visibility={identity.profileVisibility}
        cityShown={identity.cityName !== null}
      />
      <DefaultAudience humanId={humanId} />
      <LiveDefaultsSection humanId={humanId} />
      <LocationSection homeCityId={session.me?.context?.homeCityId ?? null} />
    </>
  )
}

function ProfilePrivacy({
  visibility,
  cityShown,
}: {
  visibility: ProfileVisibility
  cityShown: boolean
}) {
  const earth = useEarth()
  const session = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const update = async (input: {
    profileVisibility?: ProfileVisibility
    publicCityVisibility?: boolean
  }) => {
    setBusy(true)
    try {
      await earth.identity.update(input)
      await session.refresh()
      toast.show(youCopy.saved)
    } catch {
      toast.show(webCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title={items.profile} hint={youCopy.profileVisibilityHint[visibility]}>
      <div className="flex flex-col gap-3 px-screen-margin">
        <SegmentedText
          role="radiogroup"
          label={items.profile}
          options={PROFILE_VISIBILITY.map((option) => ({
            key: option,
            label: youCopy.profileVisibility[option],
            state: busy ? 'disabled' : 'available',
          }))}
          value={visibility}
          onSelect={(next) => {
            if (next !== visibility) void update({ profileVisibility: next })
          }}
        />
        <label className="flex min-h-touch-target items-center gap-3 text-body">
          <input
            type="checkbox"
            checked={cityShown}
            disabled={busy}
            onChange={(event) => void update({ publicCityVisibility: event.target.checked })}
            className="size-5 accent-(--earth-color-text-primary)"
          />
          {youCopy.showCity}
        </label>
      </div>
    </SettingsSection>
  )
}

export const PREFS_QUERY_KEY = 'prefs' as const

function DefaultAudience({ humanId }: { humanId: string }) {
  const queryClient = useQueryClient()
  const key = [PREFS_QUERY_KEY, humanId, 'defaultAudience'] as const
  const stored = useQuery({
    queryKey: key,
    queryFn: () => readDefaultAudience(localStore(), humanId),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const audience = stored.data ?? DEFAULT_AUDIENCE
  return (
    <SettingsSection title={items.defaultPostAudience} hint={youCopy.defaultAudienceHint}>
      <div className="flex flex-col gap-2 px-screen-margin">
        <SegmentedText
          role="radiogroup"
          label={copy.audience}
          options={AUDIENCE.map((option) => ({ key: option, label: copy.audiences[option] }))}
          value={audience}
          onSelect={(next) => {
            writeDefaultAudience(localStore(), humanId, next)
            queryClient.setQueryData(key, next)
          }}
        />
        <p className="text-meta text-text-secondary">{youCopy.storedOnDevice}</p>
      </div>
    </SettingsSection>
  )
}

function LiveDefaultsSection({ humanId }: { humanId: string }) {
  const queryClient = useQueryClient()
  const key = [PREFS_QUERY_KEY, humanId, 'live'] as const
  const stored = useQuery({
    queryKey: key,
    queryFn: () => readLiveDefaults(localStore(), humanId),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const defaults: LiveDefaults = stored.data ?? LIVE_DEFAULTS_FALLBACK
  const save = (next: LiveDefaults) => {
    writeLiveDefaults(localStore(), humanId, next)
    queryClient.setQueryData(key, next)
  }
  return (
    <SettingsSection title={items.liveDefaults} hint={youCopy.liveDefaultsHint}>
      <div className="flex flex-col gap-4 px-screen-margin">
        <div className="flex flex-col gap-1">
          <p className="text-secondary text-text-secondary">{youCopy.liveVisibility}</p>
          <SegmentedText
            role="radiogroup"
            label={youCopy.liveVisibility}
            options={LIVE_VISIBILITY_CHOICES.map((option) => ({
              key: option,
              label: copy.visibility[option],
            }))}
            value={defaults.visibility}
            onSelect={(visibility) => save({ ...defaults, visibility })}
            className="flex-wrap"
          />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-secondary text-text-secondary">{copy.whoCanJoin}</p>
          <SegmentedText
            role="radiogroup"
            label={copy.whoCanJoin}
            options={LIVE_JOIN_POLICY_CHOICES.map((option) => ({
              key: option,
              label: copy.joinPolicies[option],
            }))}
            value={defaults.joinPolicy}
            onSelect={(joinPolicy) => save({ ...defaults, joinPolicy })}
            className="flex-wrap"
          />
        </div>
        <p className="text-meta text-text-secondary">{youCopy.storedOnDevice}</p>
      </div>
    </SettingsSection>
  )
}

function LocationSection({ homeCityId }: { homeCityId: string | null }) {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly AreaDto[]>([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)

  const home = useQuery({
    queryKey: ['area', homeCityId],
    queryFn: () => earth.location.getArea(asAreaId(homeCityId ?? '')),
    enabled: runtime !== null && homeCityId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) return
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      earth.location
        .searchAreas(q)
        .then((areas) => {
          if (!cancelled) setResults(areas.filter((area) => area.type === 'city'))
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, AREA_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, earth])

  const choose = async (area: AreaDto) => {
    setBusy(true)
    try {
      await earth.identity.update({ homeCityAreaId: area.id })
      await earth.location.setContext({ homeCityId: area.id })
      await session.refresh()
      setQuery('')
      setResults([])
      toast.show(youCopy.saved)
    } catch {
      toast.show(webCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title={items.location} hint={youCopy.homeCityHint}>
      <List>
        <ListRow title={youCopy.homeCity} subtitle={home.data?.name ?? youCopy.noCredential} />
        <Link href={earthRoute()} className="block">
          <ListRow title={copy.groupInfo.locationSharing} subtitle={youCopy.manageSharing} />
        </Link>
      </List>
      <div className="flex flex-col gap-2 px-screen-margin pt-2">
        <TextField
          label={youCopy.searchCity}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            if (event.target.value.trim().length < 2) setResults([])
          }}
          trailing={searching ? webCopy.loading : undefined}
          autoComplete="off"
        />
        {results.length > 0 ? (
          <List>
            {results.map((area) => (
              <ListRow
                key={area.id}
                as="button"
                title={area.name}
                disabled={busy}
                onClick={() => void choose(area)}
                className="px-0"
              />
            ))}
          </List>
        ) : query.trim().length >= 2 && !searching ? (
          <p className="text-secondary text-text-secondary">{youCopy.noCityFound}</p>
        ) : null}
        {busy ? (
          <Button variant="quiet" loading>
            {webCopy.loading}
          </Button>
        ) : null}
      </div>
    </SettingsSection>
  )
}
