/**
 * SCREEN 04: the simple city switch — where the person is now, or their home city. Rendered as
 * the header's subtitle; a sheet lists the two.
 */
import type { AreaId } from '@earth/domain'
import { colors, radius, space } from '@earth/ui'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { Icon, ListRow, Sheet, text } from '@/components/ui'
import { feedCopy } from '@/features/feed/copy'
import { type CityChoice, selectedCityChoice } from '@/features/feed/state/feed'
import { selectionTap } from '@/lib/haptics'

export interface CitySwitchProps {
  readonly choices: readonly CityChoice[]
  /** `null` = the current city. */
  readonly selected: AreaId | null
  /** The name the feed answered with, shown when no choice matches. */
  readonly fallbackName: string | null
  readonly onSelect: (areaId: AreaId | null) => void
}

export function CitySwitch({ choices, selected, fallbackName, onSelect }: CitySwitchProps) {
  const [open, setOpen] = useState(false)
  const current = selectedCityChoice(choices, selected)
  const name = current?.name ?? fallbackName
  if (choices.length < 2) {
    return name === null ? null : (
      <Text style={[text.secondary, text.muted]} numberOfLines={1}>
        {name}
      </Text>
    )
  }
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${feedCopy.changeCity}: ${name ?? ''}`}
        hitSlop={space[2]}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <Text style={[text.secondary, text.muted, styles.name]} numberOfLines={1}>
          {name ?? feedCopy.noCityYet}
        </Text>
        <View style={styles.chevron}>
          <Icon name="chevron" size="small" color={colors.textSecondary} />
        </View>
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title={feedCopy.cityTitle} closeButton>
        <View>
          {choices.map((choice, index) => {
            const active = current?.areaId === choice.areaId
            return (
              <ListRow
                key={choice.areaId}
                title={choice.name}
                subtitle={choice.kind === 'current' ? feedCopy.currentCity : feedCopy.homeCity}
                accessibilityRole="radio"
                selected={active}
                trailing={
                  active ? <Icon name="check" size="small" color={colors.textPrimary} /> : undefined
                }
                onPress={() => {
                  selectionTap()
                  onSelect(choice.kind === 'current' ? null : choice.areaId)
                  setOpen(false)
                }}
                flush
                separator={index < choices.length - 1}
              />
            )
          })}
        </View>
      </Sheet>
    </>
  )
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'flex-start',
    minHeight: space[8],
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    marginLeft: -space[1],
    paddingHorizontal: space[1],
    borderRadius: radius.small,
  },
  pressed: { backgroundColor: colors.subtleFill },
  name: { flexShrink: 1 },
  chevron: { transform: [{ rotate: '90deg' }] },
})
