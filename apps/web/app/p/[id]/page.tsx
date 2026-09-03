/**
 * `/p/[id]` — SCREEN 07 and the public post link (spec §112). World posts are rendered on the
 * server for anyone (link previews included) through an anonymous read — never through the
 * visitor's cookies, so nothing narrower than World is ever server-rendered; everything else
 * loads on the client as the signed-in person.
 */
import { createEarthClient } from '@earth/api'
import { type PostDetailDto, PostIdSchema } from '@earth/domain'
import { APP_NAME } from '@earth/ui'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PostDetail } from '../../../components/posts/PostDetail'
import { loadWebPublicEnv } from '../../../lib/supabase/public-env'
import { createSupabaseServerClientFromCookies } from '../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

const DESCRIPTION_MAX = 160

/** An anonymous read: only what a Visitor may see (World, `PUBLIC_WORLD_ENABLED`). */
async function loadPublicPost(id: string): Promise<PostDetailDto | null> {
  try {
    const parsed = PostIdSchema.parse(id)
    const supabase = createSupabaseServerClientFromCookies({ getAll: () => [] })
    const earth = createEarthClient({ supabase, serverBaseUrl: loadWebPublicEnv().API_BASE_URL })
    const detail = await earth.posts.get(parsed)
    return detail.post.audience === 'world' ? detail : null
  } catch {
    return null
  }
}

function description(detail: PostDetailDto): string | undefined {
  const text = detail.post.text?.trim() ?? ''
  if (text.length === 0) return undefined
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text
}

type Params = Promise<{ readonly id: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params
  const detail = await loadPublicPost(id)
  if (detail === null) return { title: APP_NAME }
  const image = detail.media.find((item) => item.mediaType === 'image')
  const summary = description(detail)
  return {
    title: detail.author.displayName,
    ...(summary === undefined ? {} : { description: summary }),
    openGraph: {
      title: `${detail.author.displayName} · ${APP_NAME}`,
      ...(summary === undefined ? {} : { description: summary }),
      ...(image === undefined
        ? {}
        : { images: [{ url: image.url, width: image.width, height: image.height }] }),
    },
  }
}

export default async function PostPage({ params }: { params: Params }) {
  const { id } = await params
  const parsed = PostIdSchema.safeParse(id)
  if (!parsed.success) notFound()
  const initial = await loadPublicPost(parsed.data)
  return <PostDetail postId={parsed.data} initial={initial} />
}
