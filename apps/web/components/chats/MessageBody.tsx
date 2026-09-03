'use client'

/* eslint-disable @next/next/no-img-element -- chat media comes from signed storage URLs */
/**
 * Renderers per message type (spec §27): text, image, video, audio, file, poll, place, system.
 * Media resolves a signed URL lazily; polls vote through `poll:<option>` reactions.
 */
import type { MessageId } from '@earth/domain'
import Link from 'next/link'

import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import { cx } from '../ui/cx'
import { chatCopy } from './copy'
import { useMediaUrl } from './hooks/useMediaUrl'
import {
  type MediaPayload,
  formatBytes,
  formatDuration,
  parseMediaPayload,
  parsePlacePayload,
  parsePollPayload,
  pollOptionIdOf,
  pollVoteReaction,
} from './payloads'
import { earthPlaceRoute } from './routes'
import type { ChatMessage } from './state/messages'

export interface MessageBodyProps {
  readonly message: ChatMessage
  readonly isMine: boolean
  readonly senderName: string
  readonly onToggleReaction: (messageId: MessageId, reaction: string) => void
}

const LINK_REGEX = /(https?:\/\/[^\s]+)/g

/** Text with bare links made tappable; nothing else is parsed. */
export function TextBody({ text, isMine }: { readonly text: string; readonly isMine: boolean }) {
  const parts = text.split(LINK_REGEX)
  return (
    <p className="whitespace-pre-wrap break-words text-body">
      {parts.map((part, index) =>
        LINK_REGEX.test(part) ? (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className={cx(
              'underline underline-offset-2',
              isMine ? 'text-background' : 'text-earth-accent',
            )}
          >
            {part}
          </a>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  )
}

function MediaFrame({
  media,
  children,
}: {
  readonly media: MediaPayload
  readonly children: React.ReactNode
}) {
  const ratio =
    media.width !== null && media.height !== null && media.width > 0
      ? media.width / media.height
      : 4 / 3
  return (
    <div
      className="w-full max-w-[320px] overflow-hidden rounded-small bg-subtle-fill"
      style={{ aspectRatio: String(Math.min(2.4, Math.max(0.5, ratio))) }}
    >
      {children}
    </div>
  )
}

function ImageBody({ media, alt }: { readonly media: MediaPayload; readonly alt: string }) {
  const { url, loading } = useMediaUrl(media)
  return (
    <MediaFrame media={media}>
      {url !== null ? (
        <img src={url} alt={alt} loading="lazy" className="size-full object-cover" />
      ) : loading ? (
        <Skeleton className="size-full rounded-none" />
      ) : (
        <span className="flex size-full items-center justify-center text-meta text-text-secondary">
          {alt}
        </span>
      )}
    </MediaFrame>
  )
}

function VideoBody({ media, label }: { readonly media: MediaPayload; readonly label: string }) {
  const { url, loading } = useMediaUrl(media)
  return (
    <MediaFrame media={media}>
      {url !== null ? (
        <video
          src={url}
          controls
          preload="metadata"
          aria-label={label}
          className="size-full bg-text-primary object-contain"
        />
      ) : loading ? (
        <Skeleton className="size-full rounded-none" />
      ) : (
        <span className="flex size-full items-center justify-center text-meta text-text-secondary">
          {label}
        </span>
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
  const duration = formatDuration(media.durationMs)
  return (
    <div className="flex min-w-[200px] flex-col gap-1">
      <span
        className={cx(
          'flex items-center gap-2 text-secondary',
          isMine ? 'text-background' : 'text-text-secondary',
        )}
      >
        <Icon name="mic" size="small" />
        <span>{label}</span>
        {duration.length > 0 ? <span>· {duration}</span> : null}
      </span>
      {url !== null ? (
        <audio
          src={url}
          controls
          preload="metadata"
          aria-label={label}
          className="w-full max-w-[280px]"
        />
      ) : loading ? (
        <Skeleton className="h-8 w-full" />
      ) : null}
    </div>
  )
}

function FileBody({ media, isMine }: { readonly media: MediaPayload; readonly isMine: boolean }) {
  const { url } = useMediaUrl(media)
  const name = media.name ?? chatCopy.fileFallback
  const size = formatBytes(media.byteSize)
  const body = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-small bg-background/20">
        <Icon name="share" size="small" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body">{name}</span>
        <span className={cx('text-meta', isMine ? 'text-background/80' : 'text-text-secondary')}>
          {[size, url === null ? null : chatCopy.download].filter(Boolean).join(' · ')}
        </span>
      </span>
    </>
  )
  return url !== null ? (
    <a
      href={url}
      download={name}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3"
    >
      {body}
    </a>
  ) : (
    <span className="flex items-center gap-3">{body}</span>
  )
}

function PollBody({ message, isMine, onToggleReaction }: MessageBodyProps) {
  const poll = parsePollPayload(message.payload)
  if (poll === null) return <TextBody text={message.text ?? chatCopy.poll} isMine={isMine} />
  const votes = new Map<string, { count: number; mine: boolean }>()
  for (const summary of message.reactions) {
    const optionId = pollOptionIdOf(summary.reaction)
    if (optionId !== null) votes.set(optionId, { count: summary.count, mine: summary.reactedByMe })
  }
  const total = [...votes.values()].reduce((sum, vote) => sum + vote.count, 0)
  return (
    <div className="flex min-w-[220px] flex-col gap-2">
      <p className="text-body font-medium">{poll.question}</p>
      <ul className="flex flex-col gap-1">
        {poll.options.map((option) => {
          const vote = votes.get(option.id) ?? { count: 0, mine: false }
          const share = total === 0 ? 0 : Math.round((vote.count / total) * 100)
          return (
            <li key={option.id}>
              <button
                type="button"
                aria-pressed={vote.mine}
                disabled={message.status !== 'sent'}
                onClick={() => onToggleReaction(message.id, pollVoteReaction(option.id))}
                className={cx(
                  'relative flex min-h-touch-target w-full items-center justify-between gap-3 overflow-hidden rounded-small px-3 text-left text-body transition-colors duration-fast ease-standard',
                  isMine ? 'bg-background/15' : 'bg-background',
                  vote.mine && 'font-medium',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    'absolute inset-y-0 left-0',
                    isMine ? 'bg-background/20' : 'bg-subtle-fill',
                  )}
                  style={{ width: `${share}%` }}
                />
                <span className="relative flex items-center gap-2">
                  {vote.mine ? <Icon name="check" size="small" /> : null}
                  <span>{option.text}</span>
                </span>
                <span
                  className={cx(
                    'relative text-meta',
                    isMine ? 'text-background/80' : 'text-text-secondary',
                  )}
                >
                  {chatCopy.votes(vote.count)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function PlaceBody({
  message,
  isMine,
}: {
  readonly message: ChatMessage
  readonly isMine: boolean
}) {
  const place = parsePlacePayload(message.payload)
  if (place === null) return <TextBody text={message.text ?? chatCopy.place} isMine={isMine} />
  return (
    <Link href={earthPlaceRoute(place.placeId)} className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-small bg-background/20">
        <Icon name="location" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body font-medium">{place.name}</span>
        <span
          className={cx(
            'truncate text-meta',
            isMine ? 'text-background/80' : 'text-text-secondary',
          )}
        >
          {[place.areaName, chatCopy.openOnEarth].filter(Boolean).join(' · ')}
        </span>
      </span>
    </Link>
  )
}

export function MessageBody(props: MessageBodyProps) {
  const { message, isMine, senderName } = props
  if (message.deletedAt !== null) {
    return (
      <p className={cx('text-secondary', isMine ? 'text-background/80' : 'text-text-secondary')}>
        {chatCopy.deletedMessage}
      </p>
    )
  }
  const media = parseMediaPayload(message.payload)
  switch (message.type) {
    case 'text':
    case 'plan':
      return <TextBody text={message.text ?? ''} isMine={isMine} />
    case 'image':
      return media === null ? (
        <TextBody text={message.text ?? chatCopy.imageAlt(senderName)} isMine={isMine} />
      ) : (
        <ImageBody media={media} alt={message.text ?? chatCopy.imageAlt(senderName)} />
      )
    case 'video':
      return media === null ? (
        <TextBody text={message.text ?? chatCopy.videoLabel(senderName)} isMine={isMine} />
      ) : (
        <VideoBody media={media} label={chatCopy.videoLabel(senderName)} />
      )
    case 'audio':
      return media === null ? (
        <TextBody text={message.text ?? chatCopy.audioLabel(senderName)} isMine={isMine} />
      ) : (
        <AudioBody media={media} label={chatCopy.audioLabel(senderName)} isMine={isMine} />
      )
    case 'file':
      return media === null ? (
        <TextBody text={message.text ?? chatCopy.fileFallback} isMine={isMine} />
      ) : (
        <FileBody media={media} isMine={isMine} />
      )
    case 'poll':
      return <PollBody {...props} />
    case 'place':
      return <PlaceBody message={message} isMine={isMine} />
    case 'system':
      return <p className="text-meta text-text-secondary">{message.text ?? ''}</p>
    default: {
      const exhaustive: never = message.type
      return <TextBody text={String(exhaustive)} isMine={isMine} />
    }
  }
}
