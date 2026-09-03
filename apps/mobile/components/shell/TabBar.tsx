/**
 * Spec §50: Home · Chats · Live · Earth · You. Five icons with their labels on white over a
 * hairline; Live sits in the centre as a destination — marked by the live red when selected,
 * never a create button. Every item is a 44pt target with an accessible name and state.
 */
import { TABS, TAB_ICONS, type Tab, borderWidth, colors, copy, space, touchTarget } from '@earth/ui'
import type { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Icon } from '@/components/ui/Icon'
import { text } from '@/components/ui/text'
import { shellCopy } from '@/lib/copy'

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0]

const TAB_SET: ReadonlySet<string> = new Set<string>(TABS)

function isTab(name: string): name is Tab {
  return TAB_SET.has(name)
}

export function TabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets()
  const current = state.routes[state.index]?.name
  return (
    <View
      style={[styles.bar, { paddingBottom: insets.bottom }]}
      accessibilityRole="tablist"
      accessibilityLabel={shellCopy.mainNavigation}
    >
      {TABS.map((tab) => {
        const route = state.routes.find((candidate) => candidate.name === tab)
        const active = current === tab
        const onPress = () => {
          if (route === undefined) return
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          })
          if (!active && !event.defaultPrevented) navigation.navigate(route.name, route.params)
        }
        const color = active
          ? tab === 'live'
            ? colors.live
            : colors.textPrimary
          : colors.textSecondary
        return (
          <Pressable
            key={tab}
            onPress={onPress}
            disabled={route === undefined}
            accessibilityRole="tab"
            accessibilityLabel={copy.tabs[tab]}
            accessibilityState={{ selected: active }}
            style={styles.item}
          >
            <Icon name={TAB_ICONS[tab]} color={color} />
            <Text style={[text.meta, { color }]}>{copy.tabs[tab]}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** Whether a route name of the tab navigator is one of the five destinations. */
export function isTabRoute(name: string): boolean {
  return isTab(name)
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.background,
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.separator,
  },
  item: {
    flex: 1,
    minHeight: touchTarget + space[3],
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1],
    paddingTop: space[2],
  },
})
