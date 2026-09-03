/**
 * SCREEN 06 — the post composer: text, photos or videos (the in-app camera is an Earth capture,
 * the library an upload), an optional explicit place, and the audience button visibly next to
 * Post. Default audience is the Home radius the person came from; moving materially outward asks
 * once, calmly. Posting from a post is a reply whose audience never exceeds the root's (spec
 * §72). Visitors cannot post (spec §43).
 */
import type { Audience, PlaceDto, PostId } from '@earth/domain'
import {
  borderWidth,
  colors,
  copy,
  radius,
  space,
  spacing,
  touchTarget,
  typography,
} from '@earth/ui'
import { ResizeMode, Video } from 'expo-av'
import { Image } from 'expo-image'
import { useRouter } from 'expo-router'
import { useReducer, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { feedCopy, postCopy } from '@/features/feed/copy'
import { lightTap } from '@/lib/haptics'
import { useBack } from '@/features/feed/hooks/useBack'
import { useLastAudience } from '@/features/feed/hooks/useLastAudience'
import { type MediaUploads, useMediaUpload } from '@/features/feed/hooks/useMediaUpload'
import { useCreatePost, usePost } from '@/features/feed/hooks/usePost'
import { postRoute } from '@/features/feed/routes'
import { useFeedShell } from '@/features/feed/shell'
import {
  MEMBER_DEFAULT_AUDIENCE,
  audienceOptions,
  composerAudienceReducer,
  initialComposerAudience,
} from '@/features/feed/state/audience'
import {
  POST_MEDIA_MAX,
  type PendingMedia,
  canPost,
  postText,
  postTypeFor,
} from '@/features/feed/state/media'

import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  ScreenHeader,
  Sheet,
  Skeleton,
  Spinner,
  StatusLine,
  text,
} from '@/components/ui'
import { AudienceConfirmSheet } from './AudienceConfirmSheet'
import { AudienceSheet } from './AudienceSheet'
import { PlaceSheet } from './PlaceSheet'

export interface ComposerProps {
  /** The post being replied to; `null` for a new post. */
  readonly replyTo: PostId | null
  /** `?audience=` preset — the Home radius the composer was opened from. */
  readonly presetAudience: Audience | null
}

export function Composer({ replyTo, presetAudience }: ComposerProps) {
  const shell = useFeedShell()
  const back = useBack()
  const parent = usePost(replyTo)
  const last = useLastAudience(shell.viewerId)
  const isReply = replyTo !== null
  const backButton = <IconButton name="back" label={feedCopy.back} onPress={back} />

  if (shell.sessionStatus === 'ready' && !shell.isHuman) {
    return (
      <View style={styles.screen}>
        <ScreenHeader title={postCopy.compose} leading={backButton} />
        <EmptyState
          title={postCopy.postingIsForHumans}
          action={<Button label={copy.claimYourPlace} onPress={() => shell.openClaim('post')} />}
        />
      </View>
    )
  }

  if ((isReply && parent.detail === undefined) || last === undefined) {
    return (
      <View style={styles.screen}>
        <ScreenHeader title={isReply ? copy.reply : postCopy.compose} leading={backButton} />
        {isReply && parent.failed ? (
          <EmptyState title={postCopy.postUnavailable} />
        ) : (
          <View style={styles.skeleton}>
            <Skeleton width="33%" />
            <Skeleton height={96} />
          </View>
        )}
      </View>
    )
  }

  const cap = isReply && parent.detail !== undefined ? parent.detail.post.audience : null
  const parentName = parent.detail?.author.displayName ?? null
  return (
    <ComposerForm
      key={`${replyTo ?? 'new'}:${cap ?? 'none'}`}
      replyTo={replyTo}
      parentName={parentName}
      cap={cap}
      presetAudience={presetAudience}
      last={last}
      onBack={back}
    />
  )
}

interface ComposerFormProps {
  readonly replyTo: PostId | null
  readonly parentName: string | null
  readonly cap: Audience | null
  readonly presetAudience: Audience | null
  readonly last: Audience | null
  readonly onBack: () => void
}

function ComposerForm({
  replyTo,
  parentName,
  cap,
  presetAudience,
  last,
  onBack,
}: ComposerFormProps) {
  const shell = useFeedShell()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const create = useCreatePost()
  const media = useMediaUpload()
  const [body, setBody] = useState('')
  const [place, setPlace] = useState<PlaceDto | null>(null)
  const [placeOpen, setPlaceOpen] = useState(false)
  const [mediaOpen, setMediaOpen] = useState(false)
  const [audienceOpen, setAudienceOpen] = useState(false)
  const [audience, dispatch] = useReducer(
    composerAudienceReducer,
    { requested: presetAudience, last, cap },
    initialComposerAudience,
  )
  const options = audienceOptions(cap)
  const ready = canPost(body, media.ready.length) && !media.uploading && !create.pending

  const submit = async () => {
    if (!ready) return
    lightTap()
    try {
      const post = await create.create({
        type: postTypeFor(media.ready),
        text: postText(body),
        audience: audience.audience,
        placeId: place?.id ?? null,
        media: [...media.ready],
        parentPostId: replyTo,
      })
      media.clear()
      router.replace(postRoute(replyTo ?? post.id))
    } catch {
      shell.toast(postCopy.couldntPost)
    }
  }

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title={replyTo === null ? postCopy.compose : copy.reply}
        leading={<IconButton name="back" label={feedCopy.back} onPress={onBack} />}
      />
      {!shell.online ? <StatusLine message={copy.waitingForConnection} banner /> : null}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.screen}
      >
        <ScrollView
          style={styles.screen}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {parentName !== null ? (
            <Text style={[text.secondary, text.muted]}>{postCopy.replyingTo(parentName)}</Text>
          ) : null}
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder={replyTo === null ? postCopy.textPlaceholder : postCopy.replyPlaceholder}
            placeholderTextColor={colors.textSecondary}
            multiline
            autoFocus
            textAlignVertical="top"
            accessibilityLabel={postCopy.textLabel}
            style={[styles.inputText, text.primary, styles.input]}
          />

          {media.state.items.length > 0 ? <MediaGrid media={media} /> : null}
          {media.state.rejected > 0 ? (
            <Text style={[text.secondary, text.muted]} accessibilityLiveRegion="polite">
              {postCopy.tooManyAttachments(POST_MEDIA_MAX)}
            </Text>
          ) : null}

          <View style={styles.tools}>
            <Button
              variant="secondary"
              label={postCopy.addPhotoVideo}
              onPress={() => setMediaOpen(true)}
              disabled={media.room === 0}
            />
            {place === null ? (
              <Button
                variant="secondary"
                label={copy.addPlace}
                onPress={() => setPlaceOpen(true)}
              />
            ) : (
              <View style={styles.placeChip}>
                <Icon name="location" size="small" color={colors.textPrimary} />
                <Text style={[text.body, text.primary, styles.placeName]} numberOfLines={1}>
                  {place.name}
                </Text>
                <IconButton
                  name="close"
                  label={postCopy.removePlace}
                  color={colors.textSecondary}
                  onPress={() => setPlace(null)}
                />
              </View>
            )}
          </View>
        </ScrollView>

        <View style={[styles.bar, { paddingBottom: space[3] + insets.bottom }]}>
          <Pressable
            onPress={() => setAudienceOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`${copy.audience}: ${copy.audiences[audience.audience]}`}
            style={({ pressed }) => [styles.audienceButton, pressed && styles.pressed]}
          >
            <Text style={[text.secondary, text.muted]}>{copy.audience}</Text>
            <Text
              style={[audience.audience === 'world' ? text.bodyMedium : text.body, text.primary]}
            >
              {copy.audiences[audience.audience]}
            </Text>
            <View style={styles.chevron}>
              <Icon name="chevron" size="small" color={colors.textSecondary} />
            </View>
          </Pressable>
          <Button
            label={copy.post}
            disabled={!ready}
            loading={create.pending}
            onPress={() => void submit()}
          />
        </View>
      </KeyboardAvoidingView>

      <Sheet
        open={mediaOpen}
        onClose={() => setMediaOpen(false)}
        title={postCopy.addPhotoVideo}
        closeButton
      >
        <ListRow
          leading={<Icon name="camera" color={colors.textPrimary} />}
          title={postCopy.takePhoto}
          onPress={() => {
            setMediaOpen(false)
            void media.pick('camera')
          }}
          flush
        />
        <ListRow
          leading={<Icon name="plus" color={colors.textPrimary} />}
          title={postCopy.chooseFromLibrary}
          onPress={() => {
            setMediaOpen(false)
            void media.pick('library')
          }}
          flush
          separator={false}
        />
      </Sheet>
      <AudienceSheet
        open={audienceOpen}
        value={audience.audience}
        options={options}
        cap={cap}
        onSelect={(next) => dispatch({ type: 'choose', audience: next })}
        onClose={() => setAudienceOpen(false)}
      />
      <AudienceConfirmSheet
        pending={audience.pending}
        usual={audience.usual ?? MEMBER_DEFAULT_AUDIENCE}
        current={audience.audience}
        onConfirm={() => dispatch({ type: 'confirm' })}
        onCancel={() => dispatch({ type: 'cancel' })}
      />
      <PlaceSheet open={placeOpen} onClose={() => setPlaceOpen(false)} onPick={setPlace} />
    </View>
  )
}

function MediaGrid({ media }: { readonly media: MediaUploads }) {
  return (
    <View style={styles.grid} accessibilityLabel={postCopy.addPhotoVideo}>
      {media.state.items.map((item, index) => (
        <MediaCell
          key={item.key}
          item={item}
          index={index}
          onRemove={() => media.remove(item.key)}
        />
      ))}
    </View>
  )
}

function MediaCell({
  item,
  index,
  onRemove,
}: {
  readonly item: PendingMedia
  readonly index: number
  readonly onRemove: () => void
}) {
  return (
    <View style={styles.cell}>
      {item.picked.mediaType === 'video' ? (
        <Video
          source={{ uri: item.picked.uri }}
          style={styles.preview}
          resizeMode={ResizeMode.COVER}
          shouldPlay={false}
          isMuted
        />
      ) : (
        <Image
          source={{ uri: item.picked.uri }}
          style={styles.preview}
          contentFit="cover"
          cachePolicy="memory"
          accessible={false}
        />
      )}
      {item.status === 'uploading' ? (
        <View style={styles.overlay}>
          <View style={[styles.fill, styles.scrim]} />
          <Spinner label={postCopy.uploading} />
        </View>
      ) : null}
      {item.status === 'failed' ? (
        <View style={styles.failed}>
          <View style={[styles.fill, styles.scrimStrong]} />
          <Text style={[text.meta, text.danger]} accessibilityLiveRegion="polite">
            {postCopy.uploadFailed}
          </Text>
        </View>
      ) : null}
      <View style={styles.remove}>
        <IconButton name="close" label={postCopy.removeMedia(index + 1)} onPress={onRemove} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  skeleton: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[4], gap: space[3] },
  content: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[4], gap: space[4] },
  input: { minHeight: 160, paddingVertical: 0 },
  inputText: {
    fontSize: typography.section.size,
    lineHeight: typography.section.lineHeight,
    fontWeight: '400',
  },
  chevron: { transform: [{ rotate: '90deg' }] },
  tools: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  placeChip: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    paddingLeft: space[4],
    borderRadius: radius.medium,
    backgroundColor: colors.subtleFill,
  },
  placeName: { flexShrink: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[1] },
  cell: {
    width: '32%',
    aspectRatio: 1,
    overflow: 'hidden',
    borderRadius: radius.medium,
    backgroundColor: colors.subtleFill,
  },
  preview: { width: '100%', height: '100%' },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrim: { backgroundColor: colors.background, opacity: 0.6 },
  scrimStrong: { backgroundColor: colors.background, opacity: 0.85 },
  failed: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space[2],
    paddingVertical: space[1],
  },
  remove: { position: 'absolute', top: 0, right: 0 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[3],
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.separator,
    backgroundColor: colors.background,
  },
  audienceButton: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    paddingHorizontal: space[2],
    marginLeft: -space[2],
    borderRadius: radius.medium,
  },
  pressed: { backgroundColor: colors.subtleFill },
})
