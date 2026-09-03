'use client'

/**
 * SCREEN 12 — Group info (and the DM counterpart). Utilitarian and quiet: name / photo (owner
 * and moderators edit), "Bring them here" for a new group's owner, members with roles and
 * relation, media shared here, message search over loaded messages, location sharing state,
 * mute / notifications, invite links (owner / moderator), leave group.
 */
/* eslint-disable @next/next/no-img-element -- media grid thumbnails are signed storage URLs */
import { STORAGE_BUCKETS, type GroupInviteDto } from '@earth/api'
import {
  type ConversationDetailDto,
  type ConversationId,
  type GroupDetailDto,
  type GroupId,
  type GroupMemberDto,
  type HumanId,
  type MuteState,
  type NotificationLevel,
  groupInviteUrl,
} from '@earth/domain'
import { type ShareChannel } from '@earth/analytics'
import { copy, formatHandle, relativeTime } from '@earth/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { z } from 'zod'

import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useFlags } from '../../lib/providers/FlagsProvider'
import { useEarth, usePublicEnv } from '../../lib/providers/RuntimeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { TAB_ROUTES } from '../../lib/routes'
import { localStore, readJson, writeJson } from '../../lib/storage'
import { PageContainer } from '../shell/PageContainer'
import { ScreenHeader } from '../shell/ScreenHeader'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { Spinner } from '../ui/Spinner'
import { TextField } from '../ui/TextField'
import { useToast } from '../ui/Toast'
import { ClaimToChat } from './ChatsList'
import { HereSheet } from './HereSheet'
import { chatCopy } from './copy'
import { useMediaUrl } from './hooks/useMediaUrl'
import { CONVERSATIONS_QUERY_KEY } from './hooks/useConversationsList'
import { type MediaPayload, messagePreviewText, parseMediaPayload } from './payloads'
import { conversationRoute, profileRoute } from './routes'
import { type ChatMessage, timeLabel } from './state/messages'
import type { MessageDto } from '@earth/domain'

/** A group is "new" (spec §45 step 10 "Bring them here") while it is mostly its founder. */
export const NEW_GROUP_MEMBER_MAX = 2
export const NEW_GROUP_DAYS = 7
export const INFO_MESSAGE_PAGES = 4

export interface ConversationInfoProps {
  readonly conversationId: ConversationId
}

export const PrefsSchema = z.object({
  muteState: z.enum(['none', 'muted']),
  notificationLevel: z.enum(['all', 'mentions', 'none']),
})
export type Prefs = z.infer<typeof PrefsSchema>
export const DEFAULT_PREFS: Prefs = { muteState: 'none', notificationLevel: 'all' }

export function prefsKey(conversationId: string): string {
  return `earth.chats.prefs.${conversationId}`
}

export function isNewGroup(
  group: Pick<GroupDetailDto, 'memberCount' | 'createdAt'>,
  now: Date = new Date(),
): boolean {
  if (group.memberCount <= NEW_GROUP_MEMBER_MAX) return true
  const ageMs = now.getTime() - Date.parse(group.createdAt)
  return Number.isFinite(ageMs) && ageMs < NEW_GROUP_DAYS * 24 * 3600_000
}

export function roleLabel(role: GroupMemberDto['role']): string {
  switch (role) {
    case 'owner':
      return chatCopy.owner
    case 'moderator':
      return chatCopy.moderator
    case 'member':
      return chatCopy.member
  }
}

/** Client-side message search over loaded messages (V1; server search covers posts, not chats). */
export function searchMessages(messages: readonly MessageDto[], query: string): MessageDto[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  return messages
    .filter(
      (message) =>
        message.deletedAt === null && (message.text ?? '').toLowerCase().includes(needle),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

async function shareInviteLink(url: string): Promise<ShareChannel> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ url })
      return 'system_share'
    } catch {
      // Cancelled or unsupported: fall back to the clipboard.
    }
  }
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    await navigator.clipboard.writeText(url)
    return 'copy_link'
  }
  return 'other'
}

export function ConversationInfo({ conversationId }: ConversationInfoProps) {
  const session = useSession()
  const earth = useEarth()
  const isHuman = session.status === 'ready' && session.roleKind === 'human'
  const detail = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => earth.conversations.get(conversationId),
    enabled: isHuman,
  })
  const groupId = detail.data?.groupId ?? null
  const group = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => earth.groups.get(groupId as GroupId),
    enabled: isHuman && groupId !== null,
  })

  if (session.status === 'loading' || (isHuman && detail.isPending)) {
    return (
      <>
        <InfoHeader conversationId={conversationId} title={chatCopy.info} />
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </>
    )
  }
  if (!isHuman) {
    return (
      <>
        <InfoHeader conversationId={conversationId} title={chatCopy.info} />
        <PageContainer>
          <ClaimToChat title={chatCopy.info} />
        </PageContainer>
      </>
    )
  }
  if (detail.data === undefined) {
    return (
      <>
        <InfoHeader conversationId={conversationId} title={chatCopy.info} />
        <PageContainer>
          <EmptyState
            title={chatCopy.conversationUnavailable}
            action={
              <Button variant="secondary" onClick={() => void detail.refetch()}>
                {webCopy.retry}
              </Button>
            }
          />
        </PageContainer>
      </>
    )
  }
  return (
    <InfoBody
      conversation={detail.data}
      group={group.data ?? null}
      groupLoading={groupId !== null && group.isPending}
      refetchGroup={() => void group.refetch()}
      viewerId={session.humanId}
    />
  )
}

function InfoHeader({
  conversationId,
  title,
}: {
  readonly conversationId: string
  readonly title: string
}) {
  return (
    <ScreenHeader
      title={title}
      leading={
        <Link
          href={conversationRoute(conversationId)}
          aria-label={webCopy.back}
          className="flex size-touch-target items-center justify-center rounded-avatar text-text-primary hover:bg-subtle-fill"
        >
          <Icon name="back" />
        </Link>
      }
    />
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
    <form
      className="flex w-full items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(name)
      }}
    >
      <TextField
        className="flex-1"
        label={chatCopy.groupName}
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={60}
      />
      <Button
        type="submit"
        variant="secondary"
        loading={saving}
        disabled={initialName === name.trim()}
      >
        {chatCopy.save}
      </Button>
    </form>
  )
}

function SectionTitle({ children }: { readonly children: string }) {
  return (
    <h2 className="px-screen-margin pt-6 pb-2 text-meta text-text-secondary uppercase tracking-wide">
      {children}
    </h2>
  )
}

interface InfoBodyProps {
  readonly conversation: ConversationDetailDto
  readonly group: GroupDetailDto | null
  readonly groupLoading: boolean
  readonly refetchGroup: () => void
  readonly viewerId: HumanId | null
}

function InfoBody({ conversation, group, groupLoading, refetchGroup, viewerId }: InfoBodyProps) {
  const earth = useEarth()
  const env = usePublicEnv()
  const flags = useFlags()
  const analytics = useAnalytics()
  const toast = useToast()
  const router = useRouter()
  const queryClient = useQueryClient()
  const myRole = group?.myRole ?? null
  const canModerate = myRole === 'owner' || myRole === 'moderator'
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
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversation.id] })
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY })
    } catch {
      toast.show(webCopy.somethingWrong)
    } finally {
      setSavingName(false)
    }
  }
  const changePhoto = async (file: File | undefined) => {
    if (group === null || file === undefined) return
    try {
      const media = await earth.media.upload(file, {
        bucket: STORAGE_BUCKETS.avatars,
        contentType: file.type,
        byteSize: file.size,
      })
      await earth.groups.update({ groupId: group.id, avatarMediaId: media.id })
      refetchGroup()
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY })
    } catch {
      toast.show(chatCopy.uploadFailed)
    }
  }

  // Invite links
  const invites = useQuery({
    queryKey: ['group', group?.id ?? null, 'invites'],
    queryFn: () => earth.groups.invites.list(group?.id as GroupId),
    enabled: group !== null && canModerate,
  })
  const [freshLink, setFreshLink] = useState<{ id: string | null; url: string } | null>(null)
  const [sharing, setSharing] = useState(false)
  const origin = env?.WEB_ORIGIN ?? (typeof window === 'undefined' ? '' : window.location.origin)
  const createAndShare = async () => {
    if (group === null) return
    setSharing(true)
    try {
      const created = await earth.groups.invites.create({ groupId: group.id })
      const url = groupInviteUrl(origin, created.token)
      setFreshLink({ id: null, url })
      const channel = await shareInviteLink(url)
      if (channel === 'copy_link') toast.show(chatCopy.linkCopied)
      analytics.track('group_invite_shared', { groupId: group.id, channel })
      void invites.refetch()
    } catch {
      toast.show(webCopy.somethingWrong)
    } finally {
      setSharing(false)
    }
  }
  const copyFresh = async () => {
    if (freshLink === null || group === null) return
    const channel = await shareInviteLink(freshLink.url)
    if (channel === 'copy_link') toast.show(chatCopy.linkCopied)
    analytics.track('group_invite_shared', { groupId: group.id, channel })
  }
  const revoke = async (invite: GroupInviteDto) => {
    try {
      await earth.groups.invites.revoke(invite.id)
      void invites.refetch()
    } catch {
      toast.show(webCopy.somethingWrong)
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
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversation.id] })
    } catch {
      toast.show(webCopy.somethingWrong)
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
      toast.show(webCopy.somethingWrong)
    } finally {
      setMemberSheet(null)
    }
  }

  // Loaded messages for media and search (client-side, V1).
  const loaded = useQuery({
    queryKey: ['conversation', conversation.id, 'info-messages'],
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
  const mediaMessages = useMemo(
    () =>
      (loaded.data ?? [])
        .filter(
          (message) =>
            (message.type === 'image' || message.type === 'video') && message.deletedAt === null,
        )
        .map((message) => ({ message, media: parseMediaPayload(message.payload) }))
        .filter(
          (entry): entry is { message: MessageDto; media: MediaPayload } => entry.media !== null,
        ),
    [loaded.data],
  )
  const [search, setSearch] = useState('')
  const matches = useMemo(() => searchMessages(loaded.data ?? [], search), [loaded.data, search])
  const currentPlan = useMemo(
    () =>
      (loaded.data ?? []).find(
        (message) => message.type === 'plan' && message.deletedAt === null,
      ) ?? null,
    [loaded.data],
  )

  // Prefs (no read RPC in V1: the device remembers what was last set).
  const [prefs, setPrefs] = useState<Prefs>(
    () =>
      readJson(localStore(), prefsKey(conversation.id), (value) => {
        const parsed = PrefsSchema.safeParse(value)
        return parsed.success ? parsed.data : null
      }) ?? DEFAULT_PREFS,
  )
  const savePrefs = async (next: Partial<Prefs>) => {
    const merged = { ...prefs, ...next }
    setPrefs(merged)
    writeJson(localStore(), prefsKey(conversation.id), merged)
    try {
      const saved = await earth.conversations.setPrefs({
        conversationId: conversation.id,
        muteState: merged.muteState,
        notificationLevel: merged.notificationLevel,
      })
      const confirmed = { muteState: saved.muteState, notificationLevel: saved.notificationLevel }
      setPrefs(confirmed)
      writeJson(localStore(), prefsKey(conversation.id), confirmed)
    } catch {
      toast.show(webCopy.somethingWrong)
    }
  }
  const [levelSheet, setLevelSheet] = useState(false)

  // Leave
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const leave = async () => {
    if (group === null || myRole === null) return
    setLeaving(true)
    try {
      await earth.groups.leave(group.id)
      analytics.track('group_left', { groupId: group.id, role: myRole })
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY })
      router.push(TAB_ROUTES.chats)
    } catch {
      toast.show(webCopy.somethingWrong)
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

  return (
    <>
      <InfoHeader conversationId={conversation.id} title={chatCopy.info} />
      <PageContainer className="pb-8">
        {/* Identity */}
        <div className="flex flex-col items-center gap-3 px-screen-margin pt-6">
          <Avatar
            name={title}
            src={group?.avatarUrl ?? conversation.avatarUrls[0] ?? null}
            size="profile"
            decorative
          />
          {isGroup && canModerate ? (
            <label className="text-secondary text-earth-accent">
              <span>{chatCopy.changePhoto}</span>
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  void changePhoto(file)
                }}
              />
            </label>
          ) : null}
          {isGroup && canModerate ? (
            <GroupNameEditor
              key={group.name ?? ''}
              initialName={group.name ?? ''}
              saving={savingName}
              onSave={(next) => void saveName(next)}
            />
          ) : (
            <h2 className="text-title">{title}</h2>
          )}
          {otherMember !== null ? (
            <Link
              href={profileRoute(otherMember.handle)}
              className="text-secondary text-text-secondary"
            >
              {formatHandle(otherMember.handle)} · {chatCopy.viewProfile}
            </Link>
          ) : null}
          {isGroup ? (
            <p className="text-secondary text-text-secondary">
              {webCopy.inviteMembers(group.memberCount)}
            </p>
          ) : null}
        </div>

        {/* Bring them here (spec §45 step 10) */}
        {isGroup && isOwner && isNewGroup(group) ? (
          <div className="flex flex-col gap-2 px-screen-margin pt-6">
            <p className="text-section">{copy.bringThemHere}</p>
            <Button
              variant="primary"
              fullWidth
              loading={sharing}
              onClick={() => void createAndShare()}
            >
              {copy.shareLink}
            </Button>
            {freshLink !== null ? (
              <button
                type="button"
                onClick={() => void copyFresh()}
                className="truncate text-left text-secondary text-earth-accent"
              >
                {freshLink.url}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Current plan */}
        {isGroup ? (
          <>
            <SectionTitle>{copy.groupInfo.currentPlan}</SectionTitle>
            <p className="px-screen-margin text-body text-text-secondary">
              {currentPlan === null ? chatCopy.noPlan : (currentPlan.text ?? '')}
            </p>
          </>
        ) : null}

        {/* Members */}
        <SectionTitle>{copy.groupInfo.members}</SectionTitle>
        {groupLoading ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : (
          <List>
            {(
              group?.members ??
              conversation.members.map((member) => ({
                ...member,
                role: 'member' as const,
                status: 'active' as const,
                isFriend: false,
              }))
            ).map((member) => {
              const relation = [
                member.role !== 'member' ? roleLabel(member.role) : null,
                member.isFriend ? chatCopy.friend : null,
              ]
                .filter((part): part is string => part !== null)
                .join(' · ')
              const self = member.humanId === viewerId
              return (
                <ListRow
                  key={member.humanId}
                  as="button"
                  onClick={() => setMemberSheet(member)}
                  leading={<Avatar name={member.displayName} src={member.avatarUrl} decorative />}
                  title={self ? `${member.displayName} (${chatCopy.you})` : member.displayName}
                  subtitle={relation.length > 0 ? relation : formatHandle(member.handle)}
                  trailing={<Icon name="chevron" size="small" />}
                />
              )
            })}
          </List>
        )}

        {/* Media */}
        <SectionTitle>{copy.groupInfo.media}</SectionTitle>
        {loaded.isPending ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : mediaMessages.length === 0 ? (
          <p className="px-screen-margin text-secondary text-text-secondary">
            {chatCopy.mediaEmpty}
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-0.5 px-screen-margin">
            {mediaMessages.slice(0, 30).map(({ message, media }) => (
              <li
                key={message.id}
                className="aspect-square overflow-hidden rounded-small bg-subtle-fill"
              >
                <MediaThumb media={media} alt={messagePreviewText(message.type, message.text)} />
              </li>
            ))}
          </ul>
        )}

        {/* Search */}
        <SectionTitle>{copy.groupInfo.searchMessages}</SectionTitle>
        <div className="px-screen-margin">
          <TextField
            label={copy.groupInfo.searchMessages}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            hint={chatCopy.searchNote}
          />
        </div>
        {search.trim().length > 0 ? (
          matches.length === 0 ? (
            <p className="px-screen-margin py-3 text-secondary text-text-secondary">
              {chatCopy.noMatches}
            </p>
          ) : (
            <List className="mt-2">
              {matches.slice(0, 50).map((message) => (
                <ListRow
                  key={message.id}
                  title={message.text ?? ''}
                  subtitle={`${conversation.members.find((m) => m.humanId === message.senderHumanId)?.displayName ?? copy.human} · ${relativeTime(message.createdAt)} ${timeLabel(message.createdAt)}`}
                />
              ))}
            </List>
          )
        ) : null}

        {/* Location sharing */}
        {flags.LOCATION_SHARING_ENABLED ? (
          <>
            <SectionTitle>{copy.groupInfo.locationSharing}</SectionTitle>
            <List>
              <ListRow
                as="button"
                onClick={() => setHereOpen(true)}
                leading={<Icon name="location" />}
                title={chatCopy.locationOff}
                subtitle={chatCopy.shareOnEarth}
                trailing={<Icon name="chevron" size="small" />}
              />
            </List>
          </>
        ) : null}

        {/* Notifications */}
        <SectionTitle>{copy.groupInfo.notifications}</SectionTitle>
        <List>
          <ListRow
            as="button"
            role="switch"
            aria-checked={prefs.muteState === 'muted'}
            onClick={() =>
              void savePrefs({ muteState: prefs.muteState === 'muted' ? 'none' : 'muted' })
            }
            title={copy.groupInfo.mute}
            trailing={prefs.muteState === 'muted' ? chatCopy.muted : chatCopy.notMuted}
          />
          <ListRow
            as="button"
            onClick={() => setLevelSheet(true)}
            title={copy.groupInfo.notifications}
            trailing={chatCopy.notificationLevels[prefs.notificationLevel]}
          />
        </List>

        {/* Invite links */}
        {isGroup && canModerate ? (
          <>
            <SectionTitle>{copy.groupInfo.inviteLinks}</SectionTitle>
            <div className="px-screen-margin pb-2">
              <Button variant="secondary" loading={sharing} onClick={() => void createAndShare()}>
                {chatCopy.newInviteLink}
              </Button>
            </div>
            {invites.isPending ? (
              <div className="flex justify-center py-4">
                <Spinner />
              </div>
            ) : (invites.data ?? []).filter((invite) => invite.status === 'active').length === 0 ? (
              <p className="px-screen-margin text-secondary text-text-secondary">
                {chatCopy.invitesEmpty}
              </p>
            ) : (
              <List>
                {(invites.data ?? [])
                  .filter((invite) => invite.status === 'active')
                  .map((invite) => (
                    <ListRow
                      key={invite.id}
                      title={chatCopy.inviteUses(invite.useCount, invite.maxUses)}
                      subtitle={
                        invite.expiresAt === null
                          ? chatCopy.neverExpires
                          : chatCopy.expires(relativeTime(invite.expiresAt))
                      }
                      trailing={
                        <Button variant="quiet" onClick={() => void revoke(invite)}>
                          {chatCopy.revoke}
                        </Button>
                      }
                    />
                  ))}
              </List>
            )}
          </>
        ) : null}

        {/* Leave */}
        {isGroup && myRole !== null ? (
          <div className="px-screen-margin pt-8">
            <Button variant="destructive" fullWidth onClick={() => setConfirmLeave(true)}>
              {copy.groupInfo.leaveGroup}
            </Button>
          </div>
        ) : null}
      </PageContainer>

      {/* Sheets */}
      <Sheet
        open={memberSheet !== null}
        onClose={() => setMemberSheet(null)}
        title={memberSheet?.displayName ?? ''}
      >
        {memberSheet === null ? null : (
          <div className="flex flex-col gap-2">
            <Link
              href={profileRoute(memberSheet.handle)}
              className="flex min-h-touch-target items-center justify-center rounded-medium text-body text-text-primary hover:bg-subtle-fill"
            >
              {chatCopy.viewProfile}
            </Link>
            {isGroup &&
            isOwner &&
            memberSheet.humanId !== viewerId &&
            memberSheet.role !== 'owner' ? (
              <Button
                variant="quiet"
                fullWidth
                onClick={() =>
                  void setRole(
                    memberSheet,
                    memberSheet.role === 'moderator' ? 'member' : 'moderator',
                  )
                }
              >
                {memberSheet.role === 'moderator'
                  ? chatCopy.demoteModerator
                  : copy.groupInfo.promoteModerator}
              </Button>
            ) : null}
            {isGroup &&
            canModerate &&
            memberSheet.humanId !== viewerId &&
            memberSheet.role !== 'owner' ? (
              <Button variant="destructive" fullWidth onClick={() => setConfirmRemove(memberSheet)}>
                {copy.groupInfo.removeMember}
              </Button>
            ) : null}
          </div>
        )}
      </Sheet>
      <Sheet
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={chatCopy.removeConfirm(confirmRemove?.displayName ?? '')}
      >
        <div className="flex flex-col gap-2">
          <Button
            variant="destructive"
            fullWidth
            onClick={() => confirmRemove !== null && void removeMember(confirmRemove)}
          >
            {copy.safety.remove}
          </Button>
          <Button variant="quiet" fullWidth onClick={() => setConfirmRemove(null)}>
            {copy.notNow}
          </Button>
        </div>
      </Sheet>
      <Sheet
        open={levelSheet}
        onClose={() => setLevelSheet(false)}
        title={copy.groupInfo.notifications}
      >
        <div
          role="radiogroup"
          aria-label={copy.groupInfo.notifications}
          className="flex flex-col gap-1"
        >
          {(['all', 'mentions', 'none'] as const satisfies readonly NotificationLevel[]).map(
            (level) => (
              <Button
                key={level}
                variant="quiet"
                fullWidth
                role="radio"
                aria-checked={prefs.notificationLevel === level}
                onClick={() => {
                  void savePrefs({ notificationLevel: level })
                  setLevelSheet(false)
                }}
              >
                {chatCopy.notificationLevels[level]}
              </Button>
            ),
          )}
        </div>
      </Sheet>
      <Sheet
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={chatCopy.leaveConfirm(title)}
      >
        <p className="pb-4 text-body text-text-secondary">{chatCopy.leaveBody}</p>
        <div className="flex flex-col gap-2">
          <Button variant="destructive" fullWidth loading={leaving} onClick={() => void leave()}>
            {copy.groupInfo.leaveGroup}
          </Button>
          <Button variant="quiet" fullWidth onClick={() => setConfirmLeave(false)}>
            {copy.notNow}
          </Button>
        </div>
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

function MediaThumb({ media, alt }: { readonly media: MediaPayload; readonly alt: string }) {
  const { url } = useMediaUrl(media)
  if (url === null) return <span className="block size-full" aria-label={alt} />
  return media.contentType.startsWith('video/') ? (
    <video src={url} muted preload="metadata" aria-label={alt} className="size-full object-cover" />
  ) : (
    <img src={url} alt={alt} loading="lazy" className="size-full object-cover" />
  )
}

/** Exported for tests: a mute state's label. */
export function muteLabel(state: MuteState): string {
  return state === 'muted' ? chatCopy.muted : chatCopy.notMuted
}

/** Exported for tests: messages to search over, as the thread holds them. */
export function messagesForSearch(messages: readonly ChatMessage[]): MessageDto[] {
  return messages.filter((message) => message.status === 'sent')
}
