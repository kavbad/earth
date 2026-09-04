/**
 * Renderers per message type (spec §27): text, image, video, audio, file, poll, place, system.
 * Media resolves a signed URL lazily; polls vote through `poll:<option>` reactions; a voice
 * message plays in place; a place opens on Earth.
 */
import type { MessageId } from '@earth/domain'
import { borderWidth, colors, radius, space, touchTarget } from '@earth/ui'
import { ResizeMode, Video } from 'expo-av'
import { Image } from 'expo-image'
import { useRouter } from 'expo-router'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'

import { chatCopy } from '@/features/chats/copy'
import { useAudioPlayer } from '@/features/chats/hooks/useAudioPlayer'
import { useMediaUrl } from '@/features/chats/hooks/useMediaUrl'
import {
  type MediaPayload,
  formatBytes,
  formatDuration,
  parseMediaPayload,
  parsePlacePayload,
  parsePollPayload,
  pollOptionIdOf,
  pollVoteReaction,
} from '@/features/chats/payloads'
import { earthPlaceHref } from '@/features/chats/routes'
import type { ChatMessage } from '@/features/chats/state/messages'

import { Icon, text } from '@/components/ui'

export interface MessageBodyProps {
  readonly message: ChatMessage
  readonly isMine: boolean
  readonly senderName: string
  readonly onToggleReaction: (messageId: MessageId, reaction: string) => void
}

const LINK_REGEX = /(https?:\/\/[^\s]+)/g
const MEDIA_MAX_WIDTH = 260
/** The play control draws 40pt round; its hit area reaches the 44pt target. */
const PLAY_SIZE = touchTarget - space[1]
const PLAY_HIT_SLOP = (touchTarget - PLAY_SIZE) / 2

function inkFor(isMine: boolean) {
  return isMine ? text.inverse : text.primary
}

function mutedFor(isMine: boolean) {
  return isMine ? styles.inverseMuted : text.muted
}

/** Text with bare links made tappable; nothing else is parsed. */
export function TextBody({ value, isMine }: { readonly value: string; readonly isMine: boolean }) {
  const parts = value.split(LINK_REGEX)
  return (
    <Text style={[text.body, inkFor(isMine)]} selectable>
      {parts.map((part, index) =>
        LINK_REGEX.test(part) ? (
          <Text
            key={index}
            style={[styles.link, isMine ? text.inverse : text.accent]}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(part).catch(() => undefined)}
          >
            {part}
          </Text>
        ) : (
          <Text key={index}>{part}</Text>
        ),
      )}
    </Text>
  )
}

function frameSize(media: MediaPayload): { width: number; height: number } {
  const ratio =
    media.width !== null && media.height !== null && media.width > 0
      ? media.width / media.height
      : 4 / 3
  const clamped = Math.min(2.4, Math.max(0.5, ratio))
  return { width: MEDIA_MAX_WIDTH, height: Math.round(MEDIA_MAX_WIDTH / clamped) }
}

function MediaFrame({
  media,
  children,
}: {
  readonly media: MediaPayload
  readonly children: React.ReactNode
}) {
  return <View style={[styles.frame, frameSize(media)]}>{children}</View>
}

function Placeholder({ label, loading }: { readonly label: string; readonly loading: boolean }) {
  return (
    <View style={styles.placeholder}>
      {loading ? (
        <ActivityIndicator color={colors.textSecondary} />
      ) : (
        <Text style={[text.meta, text.muted]}>{label}</Text>
      )}
    </View>
  )
}

function ImageBody({ media, label }: { readonly media: MediaPayload; readonly label: string }) {
  const { url, loading } = useMediaUrl(media)
  return (
    <MediaFrame media={media}>
      {url !== null ? (
        <Image
          source={{ uri: url }}
          style={styles.fill}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={media.storageKey}
          accessible
          accessibilityLabel={label}
        />
      ) : (
        <Placeholder label={label} loading={loading} />
      )}
    </MediaFrame>
  )
}

function VideoBody({ media, label }: { readonly media: MediaPayload; readonly label: string }) {
  const { url, loading } = useMediaUrl(media)
  return (
    <MediaFrame media={media}>
      {url !== null ? (
        <Video
          source={{ uri: url }}
          useNativeControls
          resizeMode={ResizeMode.CONTAIN}
          style={[styles.fill, styles.video]}
          accessibilityLabel={label}
        />
      ) : (
        <Placeholder label={label} loading={loading} />
      )}
    </MediaFrame>
  )
}

function AudioBody({
  media,
  label,
  isMine,
}: {
  readonly media: MediaPayload
  readonly label: string
  readonly isMine: boolean
}) {
  const { url, loading } = useMediaUrl(media)
  const player = useAudioPlayer(url)
  const total = player.durationMs ?? media.durationMs
  const shown = player.playing || player.positionMs > 0 ? player.positionMs : total
  const duration = formatDuration(shown)
  const progress = total !== null && total > 0 ? Math.min(1, player.positionMs / total) : 0
  return (
    <View style={styles.audio}>
      <Pressable
        onPress={() => void player.toggle()}
        disabled={url === null}
        accessibilityRole="button"
        accessibilityLabel={player.playing ? chatCopy.pause : chatCopy.play}
        accessibilityState={{ disabled: url === null, busy: loading || player.loading }}
        hitSlop={PLAY_HIT_SLOP}
        style={[styles.playButton, isMine ? styles.playButtonInverse : styles.playButtonInk]}
      >
        {loading || player.loading ? (
          <ActivityIndicator color={isMine ? colors.textPrimary : colors.background} />
        ) : (
          <Icon
            name={player.playing ? 'close' : 'mic'}
            size="small"
            color={isMine ? colors.textPrimary : colors.background}
          />
        )}
      </Pressable>
      <View style={styles.audioMeta}>
        <View style={[styles.track, isMine ? styles.trackInverse : styles.trackInk]}>
          <View
            style={[
              styles.trackFill,
              isMine ? styles.trackFillInverse : styles.trackFillInk,
              { width: `${Math.round(progress * 100)}%` },
            ]}
          />
        </View>
        <Text style={[text.meta, mutedFor(isMine)]} numberOfLines={1}>
          {[label, duration].filter((part) => part.length > 0).join(' · ')}
        </Text>
      </View>
    </View>
  )
}

function FileBody({ media, isMine }: { readonly media: MediaPayload; readonly isMine: boolean }) {
  const { url } = useMediaUrl(media)
  const name = media.name ?? chatCopy.fileFallback
  const size = formatBytes(media.byteSize)
  return (
    <Pressable
      onPress={() => {
        if (url !== null) void Linking.openURL(url).catch(() => undefined)
      }}
      disabled={url === null}
      accessibilityRole="link"
      accessibilityLabel={`${name}${size.length > 0 ? ` · ${size}` : ''}`}
      style={styles.rowBody}
    >
      <View style={[styles.glyph, isMine ? styles.glyphInverse : styles.glyphInk]}>
        <Icon name="share" size="small" color={isMine ? colors.background : colors.textPrimary} />
      </View>
      <View style={styles.rowText}>
        <Text style={[text.body, inkFor(isMine)]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[text.meta, mutedFor(isMine)]} numberOfLines={1}>
          {[size, url === null ? null : chatCopy.openFile].filter(Boolean).join(' · ')}
        </Text>
      </View>
    </Pressable>
  )
}

function PollBody({ message, isMine, onToggleReaction }: MessageBodyProps) {
  const poll = parsePollPayload(message.payload)
  if (poll === null) return <TextBody value={message.text ?? chatCopy.poll} isMine={isMine} />
  const votes = new Map<string, { count: number; mine: boolean }>()
  for (const summary of message.reactions) {
    const optionId = pollOptionIdOf(summary.reaction)
    if (optionId !== null) votes.set(optionId, { count: summary.count, mine: summary.reactedByMe })
  }
  const total = [...votes.values()].reduce((sum, vote) => sum + vote.count, 0)
  return (
    <View style={styles.poll} accessibilityRole="radiogroup" accessibilityLabel={poll.question}>
      <Text style={[text.bodyMedium, inkFor(isMine)]}>{poll.question}</Text>
      {poll.options.map((option) => {
        const vote = votes.get(option.id) ?? { count: 0, mine: false }
        const share = total === 0 ? 0 : Math.round((vote.count / total) * 100)
        return (
          <Pressable
            key={option.id}
            onPress={() => onToggleReaction(message.id, pollVoteReaction(option.id))}
            disabled={message.status !== 'sent'}
            accessibilityRole="radio"
            accessibilityState={{ checked: vote.mine, disabled: message.status !== 'sent' }}
            accessibilityLabel={`${option.text} · ${chatCopy.votes(vote.count)}`}
            style={[styles.option, isMine ? styles.optionInverse : styles.optionInk]}
          >
            <View
              style={[
                styles.optionFill,
                isMine ? styles.optionFillInverse : styles.optionFillInk,
                { width: `${share}%` },
              ]}
            />
            <View style={styles.optionLabel}>
              {vote.mine ? (
                <Icon
                  name="check"
                  size="small"
                  color={isMine ? colors.background : colors.textPrimary}
                />
              ) : null}
              <Text
                style={[vote.mine ? text.bodyMedium : text.body, inkFor(isMine), styles.optionText]}
                numberOfLines={2}
              >
                {option.text}
              </Text>
            </View>
            <Text style={[text.meta, mutedFor(isMine)]}>{chatCopy.votes(vote.count)}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function PlaceBody({
  message,
  isMine,
}: {
  readonly message: ChatMessage
  readonly isMine: boolean
}) {
  const router = useRouter()
  const place = parsePlacePayload(message.payload)
  if (place === null) return <TextBody value={message.text ?? chatCopy.place} isMine={isMine} />
  return (
    <Pressable
      onPress={() => router.push(earthPlaceHref(place.placeId))}
      accessibilityRole="link"
      accessibilityLabel={`${place.name} · ${chatCopy.openOnEarth}`}
      style={styles.rowBody}
    >
      <View style={[styles.glyph, isMine ? styles.glyphInverse : styles.glyphInk]}>
        <Icon name="location" color={isMine ? colors.background : colors.textPrimary} />
      </View>
      <View style={styles.rowText}>
        <Text style={[text.bodyMedium, inkFor(isMine)]} numberOfLines={1}>
          {place.name}
        </Text>
        <Text style={[text.meta, mutedFor(isMine)]} numberOfLines={1}>
          {[place.areaName, chatCopy.openOnEarth].filter(Boolean).join(' · ')}
        </Text>
      </View>
    </Pressable>
  )
}

export function MessageBody(props: MessageBodyProps) {
  const { message, isMine, senderName } = props
  if (message.deletedAt !== null) {
    return (
      <Text style={[text.secondary, styles.italic, mutedFor(isMine)]}>
        {chatCopy.deletedMessage}
      </Text>
    )
  }
  const media = parseMediaPayload(message.payload)
  switch (message.type) {
    case 'text':
    case 'plan':
      return <TextBody value={message.text ?? ''} isMine={isMine} />
    case 'image':
      return media === null ? (
        <TextBody value={message.text ?? chatCopy.imageAlt(senderName)} isMine={isMine} />
      ) : (
        <ImageBody media={media} label={message.text ?? chatCopy.imageAlt(senderName)} />
      )
    case 'video':
      return media === null ? (
        <TextBody value={message.text ?? chatCopy.videoLabel(senderName)} isMine={isMine} />
      ) : (
        <VideoBody media={media} label={chatCopy.videoLabel(senderName)} />
      )
    case 'audio':
      return media === null ? (
        <TextBody value={message.text ?? chatCopy.audioLabel(senderName)} isMine={isMine} />
      ) : (
        <AudioBody media={media} label={chatCopy.audioLabel(senderName)} isMine={isMine} />
      )
    case 'file':
      return media === null ? (
        <TextBody value={message.text ?? chatCopy.fileFallback} isMine={isMine} />
      ) : (
        <FileBody media={media} isMine={isMine} />
      )
    case 'poll':
      return <PollBody {...props} />
    case 'place':
      return <PlaceBody message={message} isMine={isMine} />
    case 'system':
      return <Text style={[text.meta, text.muted]}>{message.text ?? ''}</Text>
    default: {
      const exhaustive: never = message.type
      return <TextBody value={String(exhaustive)} isMine={isMine} />
    }
  }
}

const styles = StyleSheet.create({
  link: { textDecorationLine: 'underline' },
  italic: { fontStyle: 'italic' },
  inverseMuted: { color: colors.separator },
  frame: { overflow: 'hidden', borderRadius: radius.small, backgroundColor: colors.subtleFill },
  fill: { width: '100%', height: '100%' },
  video: { backgroundColor: colors.textPrimary },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[3] },
  audio: { minWidth: 200, flexDirection: 'row', alignItems: 'center', gap: space[3] },
  playButton: {
    width: PLAY_SIZE,
    height: PLAY_SIZE,
    borderRadius: radius.avatar,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButtonInk: { backgroundColor: colors.textPrimary },
  playButtonInverse: { backgroundColor: colors.background },
  audioMeta: { flex: 1, gap: space[1] },
  track: { height: 3, borderRadius: radius.avatar, overflow: 'hidden' },
  trackInk: { backgroundColor: colors.separator },
  trackInverse: { backgroundColor: colors.textSecondary },
  trackFill: { height: '100%' },
  trackFillInk: { backgroundColor: colors.textPrimary },
  trackFillInverse: { backgroundColor: colors.background },
  rowBody: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: touchTarget },
  rowText: { flex: 1, minWidth: 0 },
  glyph: {
    width: space[10],
    height: space[10],
    borderRadius: radius.small,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphInk: { backgroundColor: colors.background },
  glyphInverse: { backgroundColor: colors.textSecondary },
  poll: { minWidth: 220, gap: space[2] },
  option: {
    position: 'relative',
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingHorizontal: space[3],
    borderRadius: radius.small,
    overflow: 'hidden',
  },
  optionInk: { backgroundColor: colors.background },
  optionInverse: { borderWidth: borderWidth.hairline, borderColor: colors.textSecondary },
  optionFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  optionFillInk: { backgroundColor: colors.subtleFill },
  optionFillInverse: { backgroundColor: colors.textSecondary },
  optionLabel: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  optionText: { flexShrink: 1 },
})
