/**
 * The text row control (spec §93): plain labels, no filled segmented background. The selected
 * item is primary text with a 2 px understated underline that slides between labels in 180 ms;
 * the rest is secondary gray. `claim` renders like available (the tap opens the claim sheet);
 * `disabled` is inert and faded.
 */
import { borderWidth, colors, motion, radius, space, touchTarget } from '@earth/ui'
import { useEffect, useState } from 'react'
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'

import { text } from './text'

export type SegmentState = 'available' | 'claim' | 'disabled'

export interface SegmentOption<K extends string> {
  readonly key: K
  readonly label: string
  readonly state?: SegmentState
}

export interface SegmentedTextProps<K extends string> {
  readonly label: string
  readonly options: ReadonlyArray<SegmentOption<K>>
  readonly value: K
  readonly onSelect: (key: K) => void
}

interface Box {
  readonly x: number
  readonly width: number
}

const standard = Easing.bezier(...motion.curve.standard)

export function SegmentedText<K extends string>({
  label,
  options,
  value,
  onSelect,
}: SegmentedTextProps<K>) {
  const [boxes, setBoxes] = useState<Readonly<Record<string, Box>>>({})
  const x = useSharedValue(0)
  const width = useSharedValue(0)
  const measured = useSharedValue(0)

  const box = boxes[value]
  useEffect(() => {
    if (box === undefined) return
    if (measured.value === 0) {
      x.value = box.x
      width.value = box.width
      measured.value = 1
      return
    }
    x.value = withTiming(box.x, { duration: motion.duration.fast, easing: standard })
    width.value = withTiming(box.width, { duration: motion.duration.fast, easing: standard })
  }, [box, measured, width, x])

  const underline = useAnimatedStyle(() => ({
    opacity: measured.value,
    width: width.value,
    transform: [{ translateX: x.value }],
  }))

  const onLayout = (key: string) => (event: LayoutChangeEvent) => {
    const { x: left, width: w } = event.nativeEvent.layout
    setBoxes((current) => {
      const previous = current[key]
      if (previous !== undefined && previous.x === left && previous.width === w) return current
      return { ...current, [key]: { x: left, width: w } }
    })
  }

  return (
    <View style={styles.row} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((option) => {
        const selected = option.key === value
        const disabled = option.state === 'disabled'
        return (
          <Pressable
            key={option.key}
            onLayout={onLayout(option.key)}
            onPress={() => {
              if (!disabled) onSelect(option.key)
            }}
            disabled={disabled}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected, disabled }}
            style={[styles.item, disabled && styles.disabled]}
          >
            <Text
              style={[selected ? text.bodyMedium : text.body, selected ? text.primary : text.muted]}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
      <Animated.View pointerEvents="none" style={[styles.underline, underline]} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space[5], position: 'relative' },
  item: { minHeight: touchTarget, justifyContent: 'center', paddingBottom: space[2] },
  disabled: { opacity: 0.4 },
  underline: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: borderWidth.indicator,
    borderRadius: radius.avatar,
    backgroundColor: colors.textPrimary,
  },
})
