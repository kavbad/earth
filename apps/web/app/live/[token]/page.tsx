/**
 * `/live/[token]` — the Guest room deep link (SCREEN 17–19, spec §112). Server-rendered preview
 * for anyone: faces and names, the context, who shared it, the join policy. Then the client flow:
 * "Join as Guest" → name → in the room. Public and outside the member shell.
 */
import { createEarthClient } from '@earth/api'
import { type RoomInvitePreviewDto, EarthError } from '@earth/domain'
import { APP_NAME } from '@earth/ui'
import type { Metadata } from 'next'
import Link from 'next/link'

import { GuestRoom, previewTitle } from '../../../components/rooms/GuestRoom'
import { roomCopy } from '../../../components/rooms/copy'
import { preconnectOrigin } from '../../../components/rooms/state/preconnect'
import { webCopy } from '../../../lib/copy'
import { ROUTES } from '../../../lib/routes'
import { loadWebPublicEnv } from '../../../lib/supabase/public-env'
import { createSupabaseServerClient } from '../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

type PreviewResult =
  | { readonly ok: true; readonly preview: RoomInvitePreviewDto; readonly livekitOrigin: string | null }
  | { readonly ok: false; readonly code: string }

async function loadPreview(token: string): Promise<PreviewResult> {
  try {
    const env = loadWebPublicEnv()
    const supabase = await createSupabaseServerClient()
    const earth = createEarthClient({ supabase, serverBaseUrl: env.API_BASE_URL })
    const preview = await earth.rooms.invites.preview(token)
    return { ok: true, preview, livekitOrigin: preconnectOrigin(env.LIVEKIT_URL) }
  } catch (error) {
    return { ok: false, code: error instanceof EarthError ? error.code : 'internal' }
  }
}

type Params = Promise<{ readonly token: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { token } = await params
  const result = await loadPreview(token)
  return { title: result.ok ? previewTitle(result.preview) : APP_NAME }
}

export default async function GuestRoomPage({ params }: { params: Params }) {
  const { token } = await params
  const result = await loadPreview(token)
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col px-screen-margin pt-[env(safe-area-inset-top)]">
      {result.ok && result.livekitOrigin !== null ? <link rel="preconnect" href={result.livekitOrigin} /> : null}
      <div className="flex min-h-touch-target items-center py-3">
        <Link href={ROUTES.home} className="text-title tracking-tight">
          {APP_NAME}
        </Link>
      </div>
      {result.ok ? (
        <GuestRoom token={token} preview={result.preview} />
      ) : (
        <section className="fade-in flex flex-1 flex-col gap-4 py-8">
          <h1 className="text-title">{roomCopy.linkNotUsable}</h1>
          <Link href={ROUTES.home} className="text-body text-earth-accent">
            {webCopy.backToEarth}
          </Link>
        </section>
      )}
    </main>
  )
}
