'use client'

/**
 * SCREEN 07 — post detail: author with the Human indicator, time, audience, text/media, place,
 * reactions, replies (inheriting the root audience) and the reply composer. Public links render
 * the server's copy first; everything else loads here. Failure keeps what is cached (spec §110).
 */
import type { PostDetailDto, PostId } from '@earth/domain'
import { copy } from '@earth/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { ROUTES, asRoute } from '../../lib/routes'
import { LoadingState } from '../shell/LoadingState'
import { PageContainer } from '../shell/PageContainer'
import { ScreenHeader } from '../shell/ScreenHeader'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import { Spinner } from '../ui/Spinner'
import { PostCard } from './PostCard'
import { ReplyComposer } from './ReplyComposer'
import { postCopy } from './copy'
import { usePost, useReplies } from './hooks/usePost'

export interface PostDetailProps {
  readonly postId: PostId
  /** The server-rendered post (public World links); `null` when the server could not read it. */
  readonly initial?: PostDetailDto | null
}

function DetailSkeleton() {
  return (
    <div aria-hidden="true" className="flex gap-3 px-screen-margin py-4">
      <Skeleton className="size-10 rounded-avatar" />
      <div className="flex flex-1 flex-col gap-3">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  )
}

export function PostDetail({ postId, initial }: PostDetailProps) {
  const router = useRouter()
  const analytics = useAnalytics()
  const post = usePost(postId, initial)
  const replies = useReplies(postId, post.detail?.replies ?? [])
  const composer = useRef<HTMLTextAreaElement>(null)

  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || post.detail === undefined) return
    opened.current = true
    analytics.track('post_opened', { postId, source: 'post' })
  }, [analytics, post.detail, postId])

  const back = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back()
    else router.push(asRoute(ROUTES.home))
  }

  const detail = post.detail

  return (
    <>
      <ScreenHeader
        leading={
          <button
            type="button"
            onClick={back}
            aria-label={webCopy.back}
            className="flex size-touch-target items-center justify-center rounded-avatar text-text-primary hover:bg-subtle-fill"
          >
            <Icon name="back" />
          </button>
        }
      />
      <PageContainer className="flex flex-1 flex-col">
        {detail === undefined ? (
          post.failed ? (
            // Spec §107: offline this reads "Waiting for connection", not "post unavailable".
            <LoadingState>
              <EmptyState
                title={postCopy.postUnavailable}
                action={
                  <Button variant="quiet" onClick={post.refresh}>
                    {webCopy.retry}
                  </Button>
                }
              />
            </LoadingState>
          ) : (
            <LoadingState>
              <DetailSkeleton />
            </LoadingState>
          )
        ) : (
          <div className="fade-in flex flex-1 flex-col">
            {post.refreshFailed ? (
              <p role="status" className="px-screen-margin py-2 text-secondary text-text-secondary">
                {copy.couldntRefresh}
              </p>
            ) : null}
            <PostCard
              view={detail}
              context={{ source: 'post' }}
              variant="detail"
              onReply={() => composer.current?.focus()}
              onHidden={back}
            />
            <section aria-label={copy.replies} className="flex flex-1 flex-col hairline-t">
              <h2 className="px-screen-margin pt-4 pb-1 text-section">
                {copy.replies}
                {detail.replyCount > 0 ? (
                  <span className="ml-2 text-secondary font-regular text-text-secondary">
                    {detail.replyCount}
                  </span>
                ) : null}
              </h2>
              {replies.replies.length === 0 ? (
                <p className="px-screen-margin py-3 text-secondary text-text-secondary">
                  {replies.failed ? copy.couldntRefresh : postCopy.noRepliesYet}
                </p>
              ) : (
                <ol className="flex flex-col [&>*+*]:hairline-t">
                  {replies.replies.map((reply) => (
                    <li key={reply.post.id}>
                      <PostCard view={reply} context={{ source: 'post' }} variant="reply" />
                    </li>
                  ))}
                </ol>
              )}
              {replies.hasMore ? (
                <div className="px-screen-margin py-2">
                  <Button variant="quiet" onClick={replies.loadMore} loading={replies.loadingMore}>
                    {postCopy.loadMoreReplies}
                  </Button>
                </div>
              ) : null}
              {replies.loadingMore && !replies.hasMore ? (
                <div className="flex justify-center py-4">
                  <Spinner />
                </div>
              ) : null}
            </section>
            <ReplyComposer ref={composer} parent={detail} />
          </div>
        )}
      </PageContainer>
    </>
  )
}
