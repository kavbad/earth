/**
 * SCREEN 12 — Group info (and the DM counterpart). Utilitarian and quiet: name / photo (owner
 * and moderators edit), "Bring them here" for a new group's owner, members with roles and
 * relation, media shared here, message search over loaded messages, current plan, location
 * sharing state, mute / notifications, invite links (owner / moderator; create, revoke, share
 * through the system sheet), leave group.
 */
import { STORAGE_BUCKETS, type GroupInviteDto } from '@earth/api'
import {
  type ConversationDetailDto,
  type ConversationId,
  GROUP_NAME_MAX,
  type GroupDetailDto,
  type GroupId,
  type GroupMemberDto,
  type HumanId,
  type MessageDto,
  type NotificationLevel,
  groupInviteUrl,
} from '@earth/domain'
import { colors, copy, formatHandle, radius, relativeTime, space, spacing } from '@earth/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as Clipboard from 'expo-clipboard'
import { Image } from 'expo-image'
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, Share, StyleSheet, Switch, Text, View } from 'react-native'

import {
  Avatar,
  Button,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  Screen,
  ScreenHeader,
  Sheet,
  Spinner,
  StatusLine,
  TextField,
  text,
} from '@/components/ui'
import { chatCopy } from '@/features/chats/copy'
import { conversationQueryKey } from '@/features/chats/hooks/useConversation'
import { CONVERSATIONS_QUERY_KEY } from '@/features/chats/hooks/useConversationsList'
import { useMediaUrl } from '@/features/chats/hooks/useMediaUrl'
import { pickOneImage, readFileBody } from '@/features/chats/media'
import { type MediaPayload, messagePreviewText } from '@/features/chats/payloads'
import { CHATS_ROUTE, conversationRoute, profileRoute } from '@/features/chats/routes'
import { useChatsShell } from '@/features/chats/shell'
import {
  DEFAULT_PREFS,
  INFO_MESSAGE_PAGES,
  MEDIA_GRID_MAX,
  type Prefs,
  SEARCH_RESULTS_MAX,
  canModerate as canModerateRole,
  currentPlan,
  isNewGroup,
  mediaEntries,
  memberRelationLine,
  parsePrefs,
  prefsKey,
  searchMessages,
} from '@/features/chats/state/info'
import { timeLabel } from '@/features/chats/state/messages'
import { shareInviteLink } from '@/features/chats/state/share'
import { readJson, writeJson } from '@/features/chats/storage'
import { deviceStorage } from '@/lib/deviceStorage'
import { lightTap, success } from '@/lib/haptics'

import { ClaimToChat } from './ClaimToChat'
import { HereSheet } from './HereSheet'

export interface ConversationInfoScreenProps {
  readonly conversationId: ConversationId
}

const NOTIFICATION_LEVELS = [
  'all',
  'mentions',
  'none',
] as const satisfies readonly NotificationLevel[]

/** The device's share sheet and clipboard behind `shareInviteLink`. */
const shareDeps = {
  share: (url: string) => Share.share({ message: url, url }),
  copy: (url: string) => Clipboard.setStringAsync(url),
}

export function ConversationInfoScreen({ conversationId }: ConversationInfoScreenProps) {
  const shell = useChatsShell()
  const { earth } = shell
  const router = useRouter()
  const isHuman = shell.isHuman
  const detail = useQuery({
    queryKey: conversationQueryKey(conversationId),
    queryFn: () => earth.conversations.get(conversationId),
    enabled: isHuman,
  })
  const groupId = detail.data?.groupId ?? null
  const group = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => earth.groups.get(groupId as GroupId),
    enabled: isHuman && groupId !== null,
  })
  const back = () => {
    if (router.canGoBack()) router.back()
    else router.replace(conversationRoute(conversationId))
  }
  const header = (
    <>
      <ScreenHeader
        title={chatCopy.info}
        leading={<IconButton name="back" label={chatCopy.back} onPress={back} />}
      />
      {!shell.online ? <StatusLine banner message={copy.waitingForConnection} /> : null}
    </>
  )

  if (shell.sessionStatus === 'loading' || (isHuman && detail.isPending)) {
    return (
      <Screen accessibilityLabel={chatCopy.info}>
        {header}
        <Spinner fill label={chatCopy.info} />
      </Screen>
    )
  }
  if (!isHuman) {
    return (
      <Screen accessibilityLabel={chatCopy.info}>
        {header}
        <ClaimToChat title={chatCopy.info} />
      </Screen>
    )
  }
  if (detail.data === undefined) {
    return (
      <Screen accessibilityLabel={chatCopy.info}>
        {header}
        <EmptyState
          title={shell.online ? chatCopy.conversationUnavailable : copy.couldntRefresh}
          action={
            <Button
              variant="secondary"
              label={chatCopy.retry}
              onPress={() => void detail.refetch()}
            />
          }
        />
      </Screen>
    )
  }
  return (
    <Screen accessibilityLabel={chatCopy.info}>
      {header}
      <InfoBody
        conversation={detail.data}
        group={group.data ?? null}
        groupLoading={groupId !== null && group.isPending}
        groupFailed={groupId !== null && group.isError}
        refetchGroup={() => void group.refetch()}
        viewerId={shell.viewerId}
      />
    </Screen>
  )
}

/** Keyed by the saved name, so a fresh `group_get` answer resets the field without an effect. */
function GroupNameEditor({
  initialName,
  saving,
  onSave,
}: {
  readonly initialName: string
  readonly saving: boolean
  readonly onSave: (name: string) => void
}) {
  const [name, setName] = useState(initialName)
  return (
    <View style={styles.nameRow}>
      <View style={styles.nameField}>
        <TextField
          label={chatCopy.groupName}
          value={name}
          onChangeText={setName}
          maxLength={GROUP_NAME_MAX}
          onSubmitEditing={() => onSave(name)}
        />
      </View>
      <Button
        label={chatCopy.save}
        variant="secondary"
        loading={saving}
        disabled={initialName === name.trim()}
        onPress={() => onSave(name)}
      />
    </View>
  )
}

function SectionTitle({ children }: { readonly children: string }) {
  return (
    <Text style={[text.meta, text.muted, styles.sectionTitle]} accessibilityRole="header">
      {children}
    </Text>
  )
}

interface InfoBodyProps {
  readonly conversation: ConversationDetailDto
  readonly group: GroupDetailDto | null
  readonly groupLoading: boolean
  /** `group_get` failed: the members list below falls back to conversation members. */
  readonly groupFailed: boolean
  readonly refetchGroup: () => void
  readonly viewerId: HumanId | null
}

function InfoBody({
  conversation,
  group,
  groupLoading,
  groupFailed,
  refetchGroup,
  viewerId,
}: InfoBodyProps) {
  const shell = useChatsShell()
  const { earth, flags, track, webOrigin, toast } = shell
  const router = useRouter()
  const queryClient = useQueryClient()
  const myRole = group?.myRole ?? null
  const canModerate = canModerateRole(myRole)
  const isOwner = myRole === 'owner'
  const isGroup = conversation.type === 'group' && group !== null

  // Name / photo
  const [savingName, setSavingName] = useState(false)
  const saveName = async (name: string) => {
    if (group === null) return
    setSavingName(true)
    try {
      await earth.groups.update({
        groupId: group.id,
        name: name.trim().length === 0 ? null : name.trim(),
      })
      refetchGroup()
      void queryClient.invalidateQueries({ queryKey: conversationQueryKey(conversation.id) })
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY })
    } catch {
      toast(chatCopy.somethingWrong)
    } finally {
      setSavingName(false)
    }
  }
  const changePhoto = async () => {
    if (group === null) return
    const result = await pickOneImage()
    if (result.status === 'denied') {
      toast(chatCopy.photosPermission)
      return
    }
    const picked = result.status === 'picked' ? result.media[0] : undefined
    if (picked === undefined) return
    try {
      const body = await readFileBody(picked.uri)
      const media = await earth.media.upload(body, {
        bucket: STORAGE_BUCKETS.avatars,
        contentType: picked.contentType,
        width: picked.width,
        height: picked.height,
        byteSize: picked.byteSize ?? body.byteLength,
      })
      await earth.groups.update({ groupId: group.id, avatarMediaId: media.id })
      refetchGroup()
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY })
    } catch {
      toast(chatCopy.uploadFailed)
    }
  }

  // Invite links (spec §45 step 10 "Bring them here"; SCREEN 12 "manage invite links")
  const invites = useQuery({
    queryKey: ['group', group?.id ?? null, 'invites'],
    queryFn: () => earth.groups.invites.list(group?.id as GroupId),
    enabled: group !== null && canModerate,
  })
  const [freshLink, setFreshLink] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const shareAndTrack = async (url: string) => {
    if (group === null) return
    const channel = await shareInviteLink(url, shareDeps)
    if (channel === null) return
    if (channel === 'copy_link') toast(chatCopy.linkCopied)
    success()
    track('group_invite_shared', { groupId: group.id, channel })
  }
  const createAndShare = async () => {
    if (group === null) return
    lightTap()
    setSharing(true)
    try {
      const created = await earth.groups.invites.create({ groupId: group.id })
      const url = groupInviteUrl(webOrigin, created.token)
      setFreshLink(url)
      await shareAndTrack(url)
      void invites.refetch()
    } catch {
      toast(chatCopy.somethingWrong)
    } finally {
      setSharing(false)
    }
  }
  const revoke = async (invite: GroupInviteDto) => {
    try {
      await earth.groups.invites.revoke(invite.id)
      void invites.refetch()
    } catch {
      toast(chatCopy.somethingWrong)
    }
  }

  // Members
  const [memberSheet, setMemberSheet] = useState<GroupMemberDto | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<GroupMemberDto | null>(null)
  const removeMember = async (member: GroupMemberDto) => {
    if (group === null) return
    try {
      await earth.groups.members.remove(group.id, member.humanId)
      refetchGroup()
      void queryClient.invalidateQueries({ queryKey: conversationQueryKey(conversation.id) })
    } catch {
      toast(chatCopy.somethingWrong)
    } finally {
      setConfirmRemove(null)
      setMemberSheet(null)
    }
  }
  const setRole = async (member: GroupMemberDto, role: 'moderator' | 'member') => {
    if (group === null) return
    try {
      await earth.groups.members.setRole(group.id, member.humanId, role)
      refetchGroup()
    } catch {
      toast(chatCopy.somethingWrong)
    } finally {
      setMemberSheet(null)
    }
  }

  // Loaded messages for media and search (client-side, V1).
  const loaded = useQuery({
    queryKey: [...conversationQueryKey(conversation.id), 'info-messages'],
    queryFn: async () => {
      const all: MessageDto[] = []
      let beforeId: MessageDto['id'] | null = null
      for (let page = 0; page < INFO_MESSAGE_PAGES; page += 1) {
        const result = await earth.conversations.messages.list(
          beforeId === null
            ? { conversationId: conversation.id }
            : { conversationId: conversation.id, beforeId },
        )
        all.push(...result.messages)
        if (result.nextCursor === null) break
        beforeId = result.nextCursor as MessageDto['id']
      }
      return all
    },
    staleTime: 30_000,
  })
  const media = useMemo(() => mediaEntries(loaded.data ?? []), [loaded.data])
  const [search, setSearch] = useState('')
  const matches = useMemo(() => searchMessages(loaded.data ?? [], search), [loaded.data, search])
  const plan = useMemo(() => currentPlan(loaded.data ?? []), [loaded.data])

  // Prefs (no read RPC in V1: the device remembers what was last set).
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  useEffect(() => {
    let cancelled = false
    void readJson(deviceStorage(), prefsKey(conversation.id), parsePrefs).then((stored) => {
      if (!cancelled && stored !== null) setPrefs(stored)
    })
    return () => {
      cancelled = true
    }
  }, [conversation.id])
  const savePrefs = async (next: Partial<Prefs>) => {
    const merged = { ...prefs, ...next }
    setPrefs(merged)
    void writeJson(deviceStorage(), prefsKey(conversation.id), merged)
    try {
      const saved = await earth.conversations.setPrefs({
        conversationId: conversation.id,
        muteState: merged.muteState,
        notificationLevel: merged.notificationLevel,
      })
      const confirmed = { muteState: saved.muteState, notificationLevel: saved.notificationLevel }
      setPrefs(confirmed)
      void writeJson(deviceStorage(), prefsKey(conversation.id), confirmed)
    } catch {
      toast(chatCopy.somethingWrong)
    }
  }
  const [levelSheet, setLevelSheet] = useState(false)

  // Leave
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const leave = async () => {
    if (group === null || myRole === null) return
    lightTap()
    setLeaving(true)
    try {
      await earth.groups.leave(group.id)
      track('group_left', { groupId: group.id, role: myRole })
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY })
      router.replace(CHATS_ROUTE)
    } catch {
      toast(chatCopy.somethingWrong)
      setLeaving(false)
      setConfirmLeave(false)
    }
  }

  const [hereOpen, setHereOpen] = useState(false)
  const otherMember =
    conversation.type === 'direct'
      ? (conversation.members.find((m) => m.humanId !== viewerId) ?? null)
      : null
  const title = conversation.title
  const members: readonly GroupMemberDto[] =
    group?.members ??
    conversation.members.map((member) => ({
      ...member,
      role: 'member' as const,
      status: 'active' as const,
      isFriend: false,
    }))
  const activeInvites = (invites.data ?? []).filter((invite) => invite.status === 'active')
  const muted = prefs.muteState === 'muted'

  return (
    <>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Identity */}
        <View style={styles.identity}>
          <Avatar
            name={title}
            src={group?.avatarUrl ?? conversation.avatarUrls[0] ?? null}
            size="profile"
            decorative
          />
          {isGroup && canModerate ? (
            <Button
              label={chatCopy.changePhoto}
              variant="quiet"
              onPress={() => void changePhoto()}
            />
          ) : null}
          {isGroup && canModerate ? (
            <GroupNameEditor
              key={group.name ?? ''}
              initialName={group.name ?? ''}
              saving={savingName}
              onSave={(next) => void saveName(next)}
            />
          ) : (
            <Text style={[text.title, text.primary, styles.center]} accessibilityRole="header">
              {title}
            </Text>
          )}
          {otherMember !== null ? (
            <Pressable
              onPress={() => router.push(profileRoute(otherMember.handle))}
              accessibilityRole="link"
              accessibilityLabel={chatCopy.viewProfile}
              hitSlop={space[3]}
            >
              <Text style={[text.secondary, text.muted]}>
                {formatHandle(otherMember.handle)} · {chatCopy.viewProfile}
              </Text>
            </Pressable>
          ) : null}
          {isGroup ? (
            <Text style={[text.secondary, text.muted]}>
              {chatCopy.inviteMembers(group.memberCount)}
            </Text>
          ) : null}
        </View>

        {/* Bring them here (spec §45 step 10) — the prominent share for a new group's owner */}
        {isGroup && isOwner && isNewGroup(group) ? (
          <View style={styles.bring}>
            <Text style={[text.section, text.primary]}>{copy.bringThemHere}</Text>
            <Button
              label={copy.shareLink}
              fullWidth
              loading={sharing}
              onPress={() => void createAndShare()}
            />
            {freshLink !== null ? (
              <Pressable
                onPress={() => void shareAndTrack(freshLink)}
                accessibilityRole="button"
                accessibilityLabel={copy.shareLink}
                hitSlop={space[3]}
              >
                <Text style={[text.secondary, text.accent]} numberOfLines={1}>
                  {freshLink}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* Current plan */}
        {isGroup ? (
          <>
            <SectionTitle>{copy.groupInfo.currentPlan}</SectionTitle>
            <Text style={[text.body, text.muted, styles.paragraph]}>
              {plan === null ? chatCopy.noPlan : (plan.text ?? '')}
            </Text>
          </>
        ) : null}

        {/* Members */}
        <SectionTitle>{copy.groupInfo.members}</SectionTitle>
        {groupFailed ? (
          <StatusLine
            message={copy.couldntRefresh}
            actionLabel={chatCopy.retry}
            onAction={refetchGroup}
          />
        ) : null}
        {groupLoading ? (
          <Spinner label={copy.groupInfo.members} />
        ) : (
          <View accessibilityRole="list">
            {members.map((member) => {
              const relation = memberRelationLine(member)
              const self = member.humanId === viewerId
              return (
                <ListRow
                  key={member.humanId}
                  leading={<Avatar name={member.displayName} src={member.avatarUrl} decorative />}
                  title={self ? `${member.displayName} (${chatCopy.you})` : member.displayName}
                  subtitle={relation.length > 0 ? relation : formatHandle(member.handle)}
                  trailing={<Icon name="chevron" size="small" color={colors.textSecondary} />}
                  onPress={() => setMemberSheet(member)}
                />
              )
            })}
          </View>
        )}

        {/* Media */}
        <SectionTitle>{copy.groupInfo.media}</SectionTitle>
        {loaded.isError ? (
          <StatusLine
            message={copy.couldntRefresh}
            actionLabel={chatCopy.retry}
            onAction={() => void loaded.refetch()}
          />
        ) : loaded.isPending ? (
          <Spinner label={copy.groupInfo.media} />
        ) : media.length === 0 ? (
          <Text style={[text.secondary, text.muted, styles.paragraph]}>{chatCopy.mediaEmpty}</Text>
        ) : (
          <View style={styles.grid} accessibilityRole="list">
            {media.slice(0, MEDIA_GRID_MAX).map(({ message, media: payload }) => (
              <MediaThumb
                key={message.id}
                media={payload}
                label={messagePreviewText(message.type, message.text)}
              />
            ))}
          </View>
        )}

        {/* Search */}
        <SectionTitle>{copy.groupInfo.searchMessages}</SectionTitle>
        <View style={styles.paragraph}>
          <TextField
            label={copy.groupInfo.searchMessages}
            value={search}
            onChangeText={setSearch}
            hint={chatCopy.searchNote}
            returnKeyType="search"
            hideLabel
          />
        </View>
        {search.trim().length > 0 ? (
          matches.length === 0 ? (
            <Text style={[text.secondary, text.muted, styles.paragraph, styles.noMatches]}>
              {chatCopy.noMatches}
            </Text>
          ) : (
            <View accessibilityRole="list">
              {matches.slice(0, SEARCH_RESULTS_MAX).map((message) => (
                <ListRow
                  key={message.id}
                  title={message.text ?? ''}
                  subtitle={`${conversation.members.find((m) => m.humanId === message.senderHumanId)?.displayName ?? copy.human} · ${relativeTime(message.createdAt)} ${timeLabel(message.createdAt)}`}
                />
              ))}
            </View>
          )
        ) : null}

        {/* Location sharing (spec §75: lives on the map, bounded in time) */}
        {flags.LOCATION_SHARING_ENABLED ? (
          <>
            <SectionTitle>{copy.groupInfo.locationSharing}</SectionTitle>
            <ListRow
              leading={<Icon name="location" />}
              title={chatCopy.locationOff}
              subtitle={chatCopy.shareOnEarth}
              trailing={<Icon name="chevron" size="small" color={colors.textSecondary} />}
              onPress={() => setHereOpen(true)}
            />
          </>
        ) : null}

        {/* Notifications */}
        <SectionTitle>{copy.groupInfo.notifications}</SectionTitle>
        <ListRow
          title={copy.groupInfo.mute}
          subtitle={muted ? chatCopy.muted : chatCopy.notMuted}
          trailing={
            <Switch
              value={muted}
              onValueChange={(value) => void savePrefs({ muteState: value ? 'muted' : 'none' })}
              trackColor={{ true: colors.textPrimary, false: colors.separator }}
              thumbColor={colors.background}
              accessibilityRole="switch"
              accessibilityLabel={copy.groupInfo.mute}
              accessibilityState={{ checked: muted }}
            />
          }
        />
        <ListRow
          title={copy.groupInfo.notifications}
          trailing={
            <Text style={[text.secondary, text.muted]}>
              {chatCopy.notificationLevels[prefs.notificationLevel]}
            </Text>
          }
          accessibilityLabel={`${copy.groupInfo.notifications}, ${chatCopy.notificationLevels[prefs.notificationLevel]}`}
          onPress={() => setLevelSheet(true)}
        />

        {/* Invite links */}
        {isGroup && canModerate ? (
          <>
            <SectionTitle>{copy.groupInfo.inviteLinks}</SectionTitle>
            <View style={styles.paragraph}>
              <Button
                label={chatCopy.newInviteLink}
                variant="secondary"
                loading={sharing}
                onPress={() => void createAndShare()}
              />
            </View>
            {invites.isError ? (
              <StatusLine
                message={copy.couldntRefresh}
                actionLabel={chatCopy.retry}
                onAction={() => void invites.refetch()}
              />
            ) : invites.isPending ? (
              <Spinner label={copy.groupInfo.inviteLinks} />
            ) : activeInvites.length === 0 ? (
              <Text style={[text.secondary, text.muted, styles.paragraph, styles.noMatches]}>
                {chatCopy.invitesEmpty}
              </Text>
            ) : (
              <View accessibilityRole="list">
                {activeInvites.map((invite) => (
                  <ListRow
                    key={invite.id}
                    title={chatCopy.inviteUses(invite.useCount, invite.maxUses)}
                    subtitle={
                      invite.expiresAt === null
                        ? chatCopy.neverExpires
                        : chatCopy.expires(relativeTime(invite.expiresAt))
                    }
                    trailing={
                      <Button
                        label={chatCopy.revoke}
                        variant="quiet"
                        compact
                        onPress={() => void revoke(invite)}
                      />
                    }
                  />
                ))}
              </View>
            )}
          </>
        ) : null}

        {/* Leave */}
        {isGroup && myRole !== null ? (
          <View style={styles.leave}>
            <Button
              label={copy.groupInfo.leaveGroup}
              variant="destructive"
              fullWidth
              onPress={() => setConfirmLeave(true)}
            />
          </View>
        ) : null}
      </ScrollView>

      {/* Sheets */}
      <Sheet
        open={memberSheet !== null}
        onClose={() => setMemberSheet(null)}
        title={memberSheet?.displayName ?? ''}
      >
        {memberSheet === null ? null : (
          <View style={styles.stack}>
            <Button
              label={chatCopy.viewProfile}
              variant="quiet"
              fullWidth
              onPress={() => {
                const handle = memberSheet.handle
                setMemberSheet(null)
                router.push(profileRoute(handle))
              }}
            />
            {isGroup &&
            isOwner &&
            memberSheet.humanId !== viewerId &&
            memberSheet.role !== 'owner' ? (
              <Button
                label={
                  memberSheet.role === 'moderator'
                    ? chatCopy.demoteModerator
                    : copy.groupInfo.promoteModerator
                }
                variant="quiet"
                fullWidth
                onPress={() =>
                  void setRole(
                    memberSheet,
                    memberSheet.role === 'moderator' ? 'member' : 'moderator',
                  )
                }
              />
            ) : null}
            {isGroup &&
            canModerate &&
            memberSheet.humanId !== viewerId &&
            memberSheet.role !== 'owner' ? (
              <Button
                label={copy.groupInfo.removeMember}
                variant="destructive"
                fullWidth
                onPress={() => setConfirmRemove(memberSheet)}
              />
            ) : null}
          </View>
        )}
      </Sheet>
      <Sheet
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={chatCopy.removeConfirm(confirmRemove?.displayName ?? '')}
      >
        <View style={styles.stack}>
          <Button
            label={copy.safety.remove}
            variant="destructive"
            fullWidth
            onPress={() => {
              if (confirmRemove !== null) void removeMember(confirmRemove)
            }}
          />
          <Button
            label={copy.notNow}
            variant="quiet"
            fullWidth
            onPress={() => setConfirmRemove(null)}
          />
        </View>
      </Sheet>
      <Sheet
        open={levelSheet}
        onClose={() => setLevelSheet(false)}
        title={copy.groupInfo.notifications}
      >
        <View
          style={styles.stack}
          accessibilityRole="radiogroup"
          accessibilityLabel={copy.groupInfo.notifications}
        >
          {NOTIFICATION_LEVELS.map((level) => (
            <ListRow
              key={level}
              flush
              title={chatCopy.notificationLevels[level]}
              trailing={
                prefs.notificationLevel === level ? <Icon name="check" size="small" /> : undefined
              }
              accessibilityRole="radio"
              selected={prefs.notificationLevel === level}
              onPress={() => {
                void savePrefs({ notificationLevel: level })
                setLevelSheet(false)
              }}
            />
          ))}
        </View>
      </Sheet>
      <Sheet
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={chatCopy.leaveConfirm(title)}
      >
        <Text style={[text.body, text.muted, styles.leaveBody]}>{chatCopy.leaveBody}</Text>
        <View style={styles.stack}>
          <Button
            label={copy.groupInfo.leaveGroup}
            variant="destructive"
            fullWidth
            loading={leaving}
            onPress={() => void leave()}
          />
          <Button
            label={copy.notNow}
            variant="quiet"
            fullWidth
            onPress={() => setConfirmLeave(false)}
          />
        </View>
      </Sheet>
      <HereSheet
        open={hereOpen}
        onClose={() => setHereOpen(false)}
        conversationId={conversation.id}
        conversationTitle={title}
      />
    </>
  )
}

function MediaThumb({ media, label }: { readonly media: MediaPayload; readonly label: string }) {
  const { url } = useMediaUrl(media)
  return (
    <View style={styles.thumb} accessible accessibilityRole="image" accessibilityLabel={label}>
      {url !== null && !media.contentType.startsWith('video/') ? (
        <Image
          source={{ uri: url }}
          style={styles.thumbImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={media.storageKey}
        />
      ) : (
        <View style={styles.thumbVideo}>
          <Icon name="camera" size="small" color={colors.textSecondary} />
        </View>
      )}
    </View>
  )
}

const THUMB_GAP = 2

const styles = StyleSheet.create({
  content: { paddingBottom: space[8] },
  identity: {
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[6],
  },
  center: { textAlign: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space[2], alignSelf: 'stretch' },
  nameField: { flex: 1 },
  bring: { gap: space[2], paddingHorizontal: spacing.screenMargin, paddingTop: space[6] },
  sectionTitle: {
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[6],
    paddingBottom: space[2],
  },
  paragraph: { paddingHorizontal: spacing.screenMargin },
  noMatches: { paddingVertical: space[3] },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: THUMB_GAP,
    paddingHorizontal: spacing.screenMargin,
  },
  thumb: {
    width: '32.5%',
    aspectRatio: 1,
    borderRadius: radius.small,
    overflow: 'hidden',
    backgroundColor: colors.subtleFill,
  },
  thumbImage: { width: '100%', height: '100%' },
  thumbVideo: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  leave: { paddingHorizontal: spacing.screenMargin, paddingTop: space[8] },
  stack: { gap: space[2] },
  leaveBody: { paddingBottom: space[4] },
})
