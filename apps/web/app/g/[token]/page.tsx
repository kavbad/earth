/**
 * Group invite deep link (spec §46–§47, §112): server-rendered preview — "Weekend Crew — Maya,
 * Xavier + 5 others", faces, member count — for anyone, then "Join them". Visitors continue into
 * the join-group claim flow; Humans join and open the conversation; members just open it.
 */
import { createEarthClient } from '@earth/api'
import { type GroupInvitePreviewDto, EarthError } from '@earth/domain'
import { APP_NAME, copy, participantSummary } from '@earth/ui'
import type { Metadata } from 'next'
import Link from 'next/link'

import { FaceStack } from '../../../components/ui/FaceStack'
import { webCopy } from '../../../lib/copy'
import { ROUTES } from '../../../lib/routes'
import { loadWebPublicEnv } from '../../../lib/supabase/public-env'
import { createSupabaseServerClient } from '../../../lib/supabase/server'
import { JoinInvite } from './JoinInvite'

export const dynamic = 'force-dynamic'

type PreviewResult =
  | { readonly ok: true; readonly preview: GroupInvitePreviewDto }
  | { readonly ok: false; readonly code: string }

async function loadPreview(token: string): Promise<PreviewResult> {
  try {
    const supabase = await createSupabaseServerClient()
    const earth = createEarthClient({ supabase, serverBaseUrl: loadWebPublicEnv().API_BASE_URL })
    return { ok: true, preview: await earth.groups.invites.preview(token) }
  } catch (error) {
    return { ok: false, code: error instanceof EarthError ? error.code : 'internal' }
  }
}

function previewTitle(preview: GroupInvitePreviewDto): string {
  const names = preview.sampleMembers.map((member) => member.displayName)
  const summary = participantSummary(names, preview.memberCount)
  return copy.invitePreviewTitle(preview.groupName, summary)
}

type Params = Promise<{ readonly token: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { token } = await params
  const result = await loadPreview(token)
  return { title: result.ok ? previewTitle(result.preview) : APP_NAME }
}

export default async function GroupInvitePage({ params }: { params: Params }) {
  const { token } = await params
  const result = await loadPreview(token)
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col px-screen-margin pt-[env(safe-area-inset-top)]">
      <div className="flex min-h-touch-target items-center py-3">
        <Link href={ROUTES.home} className="text-title tracking-tight">
          {APP_NAME}
        </Link>
      </div>
      {result.ok ? (
        <section className="fade-in flex flex-1 flex-col gap-6 py-8">
          <div className="flex flex-col gap-4">
            {result.preview.sampleMembers.length > 0 ? (
              <FaceStack
                people={result.preview.sampleMembers}
                total={result.preview.memberCount}
                size="large"
                label={participantSummary(
                  result.preview.sampleMembers.map((member) => member.displayName),
                  result.preview.memberCount,
                )}
              />
            ) : null}
            <h1 className="text-title">{previewTitle(result.preview)}</h1>
            <p className="text-secondary text-text-secondary">
              {webCopy.inviteMembers(result.preview.memberCount)}
            </p>
          </div>
          <JoinInvite
            token={token}
            alreadyMember={result.preview.alreadyMember}
            expired={result.preview.expired}
          />
        </section>
      ) : (
        <section className="fade-in flex flex-1 flex-col gap-4 py-8">
          <h1 className="text-title">{webCopy.inviteNotFound}</h1>
          <Link href={ROUTES.home} className="text-body text-earth-accent">
            {webCopy.backToEarth}
          </Link>
        </section>
      )}
    </main>
  )
}
