/** Sign-out that also clears the auth cookies server-side; the client `useSession().signOut()` covers in-app use. */
import { NextResponse } from 'next/server'

import { ROUTES } from '../../../lib/routes'
import { createSupabaseServerClient } from '../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const supabase = await createSupabaseServerClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL(ROUTES.home, new URL(request.url).origin), { status: 303 })
}
