/**
 * SCREEN 25 → Privacy: profile visibility and city, the default post audience, Live defaults
 * (remembered on this device until a server preference exists) and location — home city plus
 * the way to what you are sharing on Earth.
 */
import { AUDIENCE, type AreaDto, PROFILE_VISIBILITY, type ProfileVisibility } from '@earth/domain'
import { colors, copy, space } from '@earth/ui'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'

import { Icon } from '@/components/ui/Icon'
import { ListRow } from '@/components/ui/ListRow'
import { SegmentedText } from '@/components/ui/SegmentedText'
import { TextField } from '@/components/ui/TextField'
import { text } from '@/components/ui/text'

import { earthCopy, youCopy } from '../copy'
import { lightTap, selectionTap } from '../haptics'
import { useArea } from '../hooks/useArea'
import { useDefaultAudience, useLiveDefaults } from '../hooks/useDevicePrefs'
import { earthHref } from '../routes'
import { useEarthShell } from '../shell'
import { LIVE_JOIN_POLICY_CHOICES, LIVE_VISIBILITY_CHOICES } from '../state/prefs'
import {
  Note,
  SettingsBody,
  SettingsFrame,
  SettingsSection,
  SwitchRow,
  useSettingsBack,
} from './SettingsFrame'

const items = copy.settings.sections.privacy.items

export const AREA_SEARCH_DEBOUNCE_MS = 300
export const AREA_SEARCH_MIN_CHARS = 2

export function PrivacySettingsScreen() {
  const shell = useEarthShell()
  const back = useSettingsBack()
  const identity = shell.identity
  const humanId = shell.viewerId
  return (
    <SettingsFrame title={copy.settings.sections.privacy.title} onBack={back} avoidKeyboard>
      {identity === null || humanId === null ? null : (
        <>
          <ProfilePrivacy
            visibility={identity.profileVisibility}
            cityShown={identity.cityName !== null}
          />
          <DefaultAudience humanId={humanId} />
          <LiveDefaultsSection humanId={humanId} />
          <LocationSection homeCityId={shell.me?.context?.homeCityId ?? null} />
        </>
      )}
    </SettingsFrame>
  )
}

function ProfilePrivacy({
  visibility,
  cityShown,
}: {
  readonly visibility: ProfileVisibility
  readonly cityShown: boolean
}) {
  const shell = useEarthShell()
  const { earth, toast } = shell
  const [busy, setBusy] = useState(false)

  const update = async (input: {
    profileVisibility?: ProfileVisibility
    publicCityVisibility?: boolean
  }) => {
    if (busy) return
    selectionTap()
    setBusy(true)
    try {
      await earth.identity.update(input)
      await shell.refreshSession()
      toast(youCopy.saved)
    } catch {
      toast(earthCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title={items.profile} hint={youCopy.profileVisibilityHint[visibility]}>
      <SettingsBody>
        <SegmentedText
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
      </SettingsBody>
      <SwitchRow
        title={youCopy.showCity}
        value={cityShown}
        disabled={busy}
        onValueChange={(next) => void update({ publicCityVisibility: next })}
      />
    </SettingsSection>
  )
}

function DefaultAudience({ humanId }: { readonly humanId: string }) {
  const audience = useDefaultAudience(humanId)
  return (
    <SettingsSection title={items.defaultPostAudience} hint={youCopy.defaultAudienceHint}>
      <SettingsBody>
        <SegmentedText
          label={copy.audience}
          options={AUDIENCE.map((option) => ({ key: option, label: copy.audiences[option] }))}
          value={audience.value}
          onSelect={(next) => {
            selectionTap()
            audience.set(next)
          }}
        />
        <Note>{youCopy.storedOnDevice}</Note>
      </SettingsBody>
    </SettingsSection>
  )
}

function LiveDefaultsSection({ humanId }: { readonly humanId: string }) {
  const defaults = useLiveDefaults(humanId)
  return (
    <SettingsSection title={items.liveDefaults} hint={youCopy.liveDefaultsHint}>
      <SettingsBody>
        <Text style={[text.secondary, text.muted]}>{youCopy.liveVisibility}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <SegmentedText
            label={youCopy.liveVisibility}
            options={LIVE_VISIBILITY_CHOICES.map((option) => ({
              key: option,
              label: copy.visibility[option],
            }))}
            value={defaults.value.visibility}
            onSelect={(visibility) => {
              selectionTap()
              defaults.set({ ...defaults.value, visibility })
            }}
          />
        </ScrollView>
        <Text style={[text.secondary, text.muted]}>{copy.whoCanJoin}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <SegmentedText
            label={copy.whoCanJoin}
            options={LIVE_JOIN_POLICY_CHOICES.map((option) => ({
              key: option,
              label: copy.joinPolicies[option],
            }))}
            value={defaults.value.joinPolicy}
            onSelect={(joinPolicy) => {
              selectionTap()
              defaults.set({ ...defaults.value, joinPolicy })
            }}
          />
        </ScrollView>
        <Note>{youCopy.storedOnDevice}</Note>
      </SettingsBody>
    </SettingsSection>
  )
}

function LocationSection({ homeCityId }: { readonly homeCityId: string | null }) {
  const shell = useEarthShell()
  const { earth, toast } = shell
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly AreaDto[]>([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const home = useArea(homeCityId)

  useEffect(() => {
    const q = query.trim()
    if (q.length < AREA_SEARCH_MIN_CHARS) return
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
    if (busy) return
    lightTap()
    setBusy(true)
    try {
      await earth.identity.update({ homeCityAreaId: area.id })
      await earth.location.setContext({ homeCityId: area.id })
      await shell.refreshSession()
      setQuery('')
      setResults([])
      toast(youCopy.saved)
    } catch {
      toast(earthCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  const typed = query.trim().length >= AREA_SEARCH_MIN_CHARS

  return (
    <SettingsSection title={items.location} hint={youCopy.homeCityHint}>
      <ListRow title={youCopy.homeCity} subtitle={home.data?.name ?? youCopy.noCredential} />
      <ListRow
        title={copy.groupInfo.locationSharing}
        subtitle={youCopy.manageSharing}
        trailing={<Icon name="chevron" size="small" color={colors.textSecondary} />}
        onPress={() => router.push(earthHref())}
      />
      <View style={styles.search}>
        <SettingsBody>
          <TextField
            label={youCopy.searchCity}
            value={query}
            autoCorrect={false}
            onChangeText={(value) => {
              setQuery(value)
              if (value.trim().length < AREA_SEARCH_MIN_CHARS) setResults([])
            }}
            trailing={searching ? earthCopy.loading : undefined}
          />
          {results.length > 0 ? (
            <View>
              {results.map((area, index) => (
                <ListRow
                  key={area.id}
                  flush
                  title={area.name}
                  disabled={busy}
                  separator={index < results.length - 1}
                  onPress={() => void choose(area)}
                />
              ))}
            </View>
          ) : typed && !searching ? (
            <Text style={[text.secondary, text.muted]}>{youCopy.noCityFound}</Text>
          ) : null}
        </SettingsBody>
      </View>
    </SettingsSection>
  )
}

const styles = StyleSheet.create({
  search: { paddingTop: space[2] },
})
