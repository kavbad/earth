/**
 * Where an OTP email link lands (`emailRedirectTo`): exchanges the code / token hash for a
 * session (route handlers may write cookies), then continues to `next` — the claim step the
 * person was on, or Home.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { ROUTES, safeNextPath } from '../../../lib/routes'
import { createSupabaseServerClient } from '../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

const EmailOtpTypeSchema = z.enum([
  'email',
  'magiclink',
  'signup',
  'invite',
  'recovery',
  'email_change',
])

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const next = safeNextPath(url.searchParams.get('next'), ROUTES.home)
  const code = url.searchParams.get('code')
  const tokenHash = url.searchParams.get('token_hash')
  const type = EmailOtpTypeSchema.safeParse(url.searchParams.get('type'))

  const supabase = await createSupabaseServerClient()
  if (code !== null && code !== '') {
    await supabase.auth.exchangeCodeForSession(code)
  } else if (tokenHash !== null && tokenHash !== '' && type.success) {
    await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type.data })
  }
  return NextResponse.redirect(new URL(next, url.origin), { status: 303 })
}
