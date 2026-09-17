/**
 * SCREEN 15 — Open up. Shows the current visibility, the options the context and flags allow,
 * "Who can join" underneath with explanatory microcopy, and the pending state while an outward
 * change waits for everyone on camera (ARCHITECTURE §10). Options come from `state/openUp.ts`.
 */
import type { FeatureFlags } from '@earth/config'
import type { RoomDto, RoomJoinPolicy, RoomVisibility } from '@earth/domain'
import { colors, copy, radius, space, touchTarget } from '@earth/ui'
import { useReducer } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { StatusLine } from '@/components/ui/StatusLine'
import { text } from '@/components/ui/text'
import { roomCopy } from '@/features/rooms/copy'
import { pendingConsentCount } from '@/features/rooms/state/consent'
import {
  defaultJoinPolicyFor,
  openUpFormReducer,
  openUpJoinPolicyOptions,
  openUpVisibilityOptions,
} from '@/features/rooms/state/openUp'

export interface OpenUpSheetProps {
  readonly open: boolean
  readonly room: Pick<
    RoomDto,
    'contextType' | 'visibility' | 'joinPolicy' | 'pendingVisibility' | 'participants'
  >
  readonly flags: FeatureFlags
  readonly busy?: boolean
  readonly error?: string | null
  readonly onApply: (visibility: RoomVisibility, joinPolicy: RoomJoinPolicy) => void
  readonly onClose: () => void
}

function OptionRow<K extends string>({
  value,
  label,
  description,
  checked,
  current = false,
  onSelect,
}: {
  readonly value: K
  readonly label: string
  readonly description: string
  readonly checked: boolean
  readonly current?: boolean
  readonly onSelect: (value: K) => void
}) {
  return (
    <Pressable
      onPress={() => onSelect(value)}
      accessibilityRole="radio"
      accessibilityLabel={current ? `${label}, ${roomCopy.currentVisibility}` : label}
      accessibilityHint={description}
      accessibilityState={{ checked }}
      style={({ pressed }) => [styles.option, (checked || pressed) && styles.optionChecked]}
    >
      <View style={[styles.radio, checked && styles.radioChecked]} />
      <View style={styles.optionText}>
        <View style={styles.optionTitle}>
          <Text style={[text.body, text.primary]}>{label}</Text>
          {current ? (
            <Text style={[text.meta, text.muted]}>{roomCopy.currentVisibility}</Text>
          ) : null}
        </View>
        <Text style={[text.secondary, text.muted]}>{description}</Text>
      </View>
    </Pressable>
  )
}

function OpenUpForm({
  room,
  flags,
  busy = false,
  error = null,
  onApply,
  onClose,
}: Omit<OpenUpSheetProps, 'open'>) {
  const [form, dispatch] = useReducer(openUpFormReducer(room.contextType), {
    visibility: room.pendingVisibility ?? room.visibility,
    joinPolicy: room.joinPolicy,
  })
  const visibilityOptions = openUpVisibilityOptions(room.contextType, flags, room.visibility)
  const policyOptions = openUpJoinPolicyOptions(form.visibility, room.contextType)
  const effectivePolicy = defaultJoinPolicyFor(form.visibility, room.contextType, form.joinPolicy)
  const pendingCount = pendingConsentCount(room)
  const unchanged = form.visibility === room.visibility && effectivePolicy === room.joinPolicy

  return (
    <View style={styles.form}>
      {room.pendingVisibility !== null ? (
        <StatusLine
          message={`${roomCopy.pendingVisibility(copy.visibility[room.pendingVisibility])}${
            pendingCount > 0 ? ` ${roomCopy.pendingCount(pendingCount)}` : ''
          }`}
        />
      ) : null}
      <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={copy.openUp}>
        <Text style={[text.meta, text.muted]}>{copy.openUp}</Text>
        {visibilityOptions.map((option) => (
          <OptionRow
            key={option.visibility}
            value={option.visibility}
            label={option.label}
            description={option.description}
            checked={option.visibility === form.visibility}
            current={option.visibility === room.visibility}
            onSelect={(visibility) => dispatch({ type: 'visibility', visibility })}
          />
        ))}
      </View>
      <View
        style={styles.group}
        accessibilityRole="radiogroup"
        accessibilityLabel={copy.whoCanJoin}
      >
        <Text style={[text.meta, text.muted]}>{copy.whoCanJoin}</Text>
        {policyOptions.map((option) => (
          <OptionRow
            key={option.joinPolicy}
            value={option.joinPolicy}
            label={option.label}
            description={option.description}
            checked={option.joinPolicy === effectivePolicy}
            onSelect={(joinPolicy) => dispatch({ type: 'joinPolicy', joinPolicy })}
          />
        ))}
      </View>
      <Text style={[text.meta, text.muted]}>{roomCopy.consentAllRequired}</Text>
      {error !== null ? <StatusLine message={error} danger /> : null}
      <View style={styles.actions}>
        <Button
          variant="primary"
          fullWidth
          loading={busy}
          disabled={unchanged}
          label={roomCopy.applyVisibility}
          onPress={() => onApply(form.visibility, effectivePolicy)}
        />
        <Button variant="quiet" fullWidth label={copy.notNow} onPress={onClose} />
      </View>
    </View>
  )
}

export function OpenUpSheet(props: OpenUpSheetProps) {
  const { open, onClose } = props
  return (
    <Sheet open={open} onClose={onClose} title={copy.openUp} closeButton scroll>
      {open ? <OpenUpForm {...props} /> : null}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  form: { gap: space[5], paddingBottom: space[2] },
  group: { gap: space[1] },
  option: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space[3],
    paddingHorizontal: space[2],
    paddingVertical: space[2],
    borderRadius: radius.medium,
  },
  optionChecked: { backgroundColor: colors.subtleFill },
  radio: {
    width: space[4],
    height: space[4],
    marginTop: space[1],
    borderRadius: radius.avatar,
    borderWidth: 1.5,
    borderColor: colors.textSecondary,
  },
  radioChecked: { borderColor: colors.textPrimary, borderWidth: 5 },
  optionText: { flex: 1, minWidth: 0 },
  optionTitle: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  actions: { gap: space[2] },
})
