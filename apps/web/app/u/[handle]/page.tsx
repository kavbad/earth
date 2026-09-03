/**
 * `/u/[handle]` — SCREEN 22, reached as `/@handle` (spec §112) through the rewrite in
 * `next.config.ts`. Public profiles are rendered on the server through an anonymous read so a
 * shared link previews; limited/hidden profiles load on the client as the signed-in person.
 */
import { HandleLookupSchema, createEarthClient } from '@earth/api'
import type { ProfileDto } from '@earth/domain'
import { APP_NAME, formatHandle } from '@earth/ui'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { ProfileScreen } from '../../../components/profile/ProfileScreen'
import { loadWebPublicEnv } from '../../../lib/supabase/public-env'
import { createSupabaseServerClientFromCookies } from '../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

/** An anonymous read: only public profiles answer (spec §43). */
async function loadPublicProfile(handle: string): Promise<ProfileDto | null> {
  try {
    const supabase = createSupabaseServerClientFromCookies({ getAll: () => [] })
    const earth = createEarthClient({ supabase, serverBaseUrl: loadWebPublicEnv().API_BASE_URL })
    const profile = await earth.social.profile(handle)
    return profile.identity.profileVisibility === 'public' ? profile : null
  } catch {
    return null
  }
}

type Params = Promise<{ readonly handle: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { handle } = await params
  const parsed = HandleLookupSchema.safeParse(handle)
  if (!parsed.success) return { title: APP_NAME }
  const profile = await loadPublicProfile(parsed.data)
  if (profile === null) return { title: formatHandle(parsed.data) }
  const bio = profile.identity.bio?.trim() ?? ''
  return {
    title: profile.identity.displayName,
    ...(bio === '' ? {} : { description: bio }),
    openGraph: {
      title: `${profile.identity.displayName} (${formatHandle(profile.identity.handle)}) · ${APP_NAME}`,
      ...(bio === '' ? {} : { description: bio }),
      ...(profile.identity.avatarUrl === null
        ? {}
        : { images: [{ url: profile.identity.avatarUrl }] }),
    },
  }
}

export default async function ProfilePage({ params }: { params: Params }) {
  const { handle } = await params
  const parsed = HandleLookupSchema.safeParse(handle)
  if (!parsed.success) notFound()
  const initial = await loadPublicProfile(parsed.data)
  return <ProfileScreen handle={parsed.data} initial={initial} />
}
