'use client'

/**
 * SCREEN 06 — the post composer: text, photos or videos, an optional explicit place, and the
 * audience button visibly next to Post. Default audience is the Home radius the person came
 * from; moving materially outward asks once, calmly. Posting from a post is a reply whose
 * audience never exceeds the root's (spec §72). Visitors cannot post (spec §43).
 */
/* eslint-disable @next/next/no-img-element -- previews are local object URLs */
import type { Audience, PlaceDto, PostId } from '@earth/domain'
import { copy } from '@earth/ui'
import { useRouter } from 'next/navigation'
import { type ChangeEvent, useReducer, useRef, useState } from 'react'

import { webCopy } from '../../lib/copy'
import { useSession } from '../../lib/providers/SessionProvider'
import { localStore } from '../../lib/storage'
import { PlaceSheet } from '../chats/PlaceSheet'
import { useClaimGate } from '../shell/ClaimSheet'
import { PageContainer } from '../shell/PageContainer'
import { ScreenHeader } from '../shell/ScreenHeader'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import { Spinner } from '../ui/Spinner'
import { useToast } from '../ui/Toast'
import { cx } from '../ui/cx'
import { AudienceConfirmSheet } from './AudienceConfirmSheet'
import { AudienceSheet } from './AudienceSheet'
import { postCopy } from './copy'
import { useMediaUpload } from './hooks/useMediaUpload'
import { useCreatePost, usePost } from './hooks/usePost'
import { postRoute } from './routes'
import {
  MEMBER_DEFAULT_AUDIENCE,
  audienceOptions,
  composerAudienceReducer,
  initialComposerAudience,
  readLastAudience,
} from './state/audience'
import { POST_MEDIA_ACCEPT, POST_MEDIA_MAX, canPost, postText, postTypeFor } from './state/media'

export interface ComposerProps {
  /** The post being replied to; `null` for a new post. */
  readonly replyTo: PostId | null
  /** `?audience=` preset — the Home radius the composer was opened from. */
  readonly presetAudience: Audience | null
}

function BackButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={webCopy.back}
      className="flex size-touch-target items-center justify-center rounded-avatar text-text-primary hover:bg-subtle-fill"
    >
      <Icon name="back" />
    </button>
  )
}

export function Composer({ replyTo, presetAudience }: ComposerProps) {
  const session = useSession()
  const gate = useClaimGate()
  const router = useRouter()
  const parent = usePost(replyTo)
  const isReply = replyTo !== null

  if (session.status === 'loading') {
    return (
      <>
        <ScreenHeader
          title={isReply ? copy.reply : postCopy.compose}
          leading={<BackButton onClick={() => router.back()} />}
        />
        <PageContainer>
          <div aria-hidden="true" className="flex flex-col gap-3 px-screen-margin py-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        </PageContainer>
      </>
    )
  }

  if (session.roleKind !== 'human') {
    return (
      <>
        <ScreenHeader
          title={postCopy.compose}
          leading={<BackButton onClick={() => router.back()} />}
        />
        <PageContainer>
          <EmptyState
            title={postCopy.postingIsForHumans}
            action={
              <Button variant="primary" onClick={() => gate.open('post')}>
                {copy.claimYourPlace}
              </Button>
            }
          />
        </PageContainer>
      </>
    )
  }

  if (isReply && parent.detail === undefined) {
    return (
      <>
        <ScreenHeader title={copy.reply} leading={<BackButton onClick={() => router.back()} />} />
        <PageContainer>
          {parent.failed ? (
            <EmptyState title={postCopy.postUnavailable} />
          ) : (
            <div aria-hidden="true" className="flex flex-col gap-3 px-screen-margin py-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
        </PageContainer>
      </>
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
      humanId={session.humanId}
      onBack={() => router.back()}
    />
  )
}

interface ComposerFormProps {
  readonly replyTo: PostId | null
  readonly parentName: string | null
  readonly cap: Audience | null
  readonly presetAudience: Audience | null
  readonly humanId: string | null
  readonly onBack: () => void
}

function ComposerForm({
  replyTo,
  parentName,
  cap,
  presetAudience,
  humanId,
  onBack,
}: ComposerFormProps) {
  const router = useRouter()
  const toast = useToast()
  const create = useCreatePost()
  const media = useMediaUpload()
  const [text, setText] = useState('')
  const [place, setPlace] = useState<PlaceDto | null>(null)
  const [placeOpen, setPlaceOpen] = useState(false)
  const [audienceOpen, setAudienceOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [audience, dispatch] = useReducer(
    composerAudienceReducer,
    { requested: presetAudience, last: readLastAudience(localStore(), humanId), cap },
    initialComposerAudience,
  )
  const options = audienceOptions(cap)
  const ready = canPost(text, media.ready.length) && !media.uploading && !create.pending

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length > 0) media.add(files)
    event.target.value = ''
  }

  const submit = async () => {
    if (!ready) return
    try {
      const post = await create.create({
        type: postTypeFor(media.ready),
        text: postText(text),
        audience: audience.audience,
        placeId: place?.id ?? null,
        media: [...media.ready],
        parentPostId: replyTo,
      })
      media.clear()
      router.replace(postRoute(replyTo ?? post.id))
    } catch {
      toast.show(postCopy.couldntPost)
    }
  }

  return (
    <>
      <ScreenHeader
        title={replyTo === null ? postCopy.compose : copy.reply}
        {...(parentName === null ? {} : { subtitle: postCopy.replyingTo(parentName) })}
        leading={<BackButton onClick={onBack} />}
      />
      <PageContainer className="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-4 px-screen-margin py-4">
          <label className="block">
            <span className="sr-only">{postCopy.textLabel}</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={replyTo === null ? postCopy.textPlaceholder : postCopy.replyPlaceholder}
              rows={5}
              autoFocus
              className="min-h-40 w-full resize-none bg-transparent text-section font-regular text-text-primary placeholder:text-text-secondary"
            />
          </label>

          {media.items.length > 0 ? (
            <ul className="grid grid-cols-3 gap-1" aria-label={postCopy.addPhotoVideo}>
              {media.items.map((item, index) => (
                <li
                  key={item.key}
                  className="relative aspect-square overflow-hidden rounded-medium bg-subtle-fill"
                >
                  {item.mediaType === 'video' ? (
                    <video
                      src={item.previewUrl}
                      muted
                      playsInline
                      preload="metadata"
                      aria-hidden="true"
                      className="size-full object-cover"
                    />
                  ) : (
                    <img src={item.previewUrl} alt="" className="size-full object-cover" />
                  )}
                  {item.status === 'uploading' ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                      <Spinner label={postCopy.uploading} />
                    </span>
                  ) : null}
                  {item.status === 'failed' ? (
                    <span
                      role="status"
                      className="absolute inset-x-0 bottom-0 bg-background/80 px-2 py-1 text-meta text-danger"
                    >
                      {postCopy.uploadFailed}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => media.remove(item.key)}
                    aria-label={postCopy.removeMedia(index + 1)}
                    className="absolute top-1 right-1 flex size-8 items-center justify-center rounded-avatar bg-background/90 text-text-primary"
                  >
                    <Icon name="close" size="small" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {media.rejected > 0 ? (
            <p role="status" className="text-secondary text-text-secondary">
              {postCopy.tooManyAttachments(POST_MEDIA_MAX)}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept={POST_MEDIA_ACCEPT}
              multiple
              onChange={onFiles}
              className="sr-only"
              aria-label={postCopy.addPhotoVideo}
              tabIndex={-1}
            />
            <Button
              variant="secondary"
              onClick={() => fileInput.current?.click()}
              disabled={media.items.length >= POST_MEDIA_MAX}
            >
              <span className="inline-flex items-center gap-2">
                <Icon name="camera" size="small" />
                {postCopy.addPhotoVideo}
              </span>
            </Button>
            {place === null ? (
              <Button variant="secondary" onClick={() => setPlaceOpen(true)}>
                <span className="inline-flex items-center gap-2">
                  <Icon name="location" size="small" />
                  {copy.addPlace}
                </span>
              </Button>
            ) : (
              <span className="inline-flex min-h-touch-target items-center gap-1 rounded-medium bg-subtle-fill pl-4 text-body">
                <Icon name="location" size="small" />
                <span className="truncate">{place.name}</span>
                <button
                  type="button"
                  onClick={() => setPlace(null)}
                  aria-label={postCopy.removePlace}
                  className="flex size-touch-target items-center justify-center rounded-avatar text-text-secondary"
                >
                  <Icon name="close" size="small" />
                </button>
              </span>
            )}
          </div>
        </div>

        <div className="sticky bottom-0 z-sticky flex items-center justify-between gap-3 bg-background px-screen-margin py-3 pb-[calc(var(--earth-space-3)+env(safe-area-inset-bottom))] hairline-t">
          <button
            type="button"
            onClick={() => setAudienceOpen(true)}
            aria-haspopup="dialog"
            aria-label={`${copy.audience}: ${copy.audiences[audience.audience]}`}
            className={cx(
              'inline-flex min-h-touch-target items-center gap-1 rounded-medium px-2 text-body transition-colors duration-fast ease-standard hover:bg-subtle-fill',
              audience.audience === 'world' ? 'font-medium text-text-primary' : 'text-text-primary',
            )}
          >
            <span className="text-secondary text-text-secondary">{copy.audience}</span>
            <span>{copy.audiences[audience.audience]}</span>
            <Icon name="chevron" size="small" className="rotate-90 text-text-secondary" />
          </button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={create.pending}
            onClick={() => void submit()}
          >
            {copy.post}
          </Button>
        </div>
      </PageContainer>

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
    </>
  )
}
