/**
 * Keeps the Supabase auth cookies fresh on every navigation (`@supabase/ssr` pattern): server
 * components can read cookies but not write them, so an expired access token is refreshed here
 * and written to the response. No authorization happens in this file — the database enforces
 * it (ARCHITECTURE §1); pages only reflect the session.
 */
import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'

import { readPublicEnv } from './lib/env'

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request })
  const env = readPublicEnv()
  if (!env.ok) return response

  const supabase = createServerClient(env.env.SUPABASE_URL, env.env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
      },
    },
  })

  // Reading the user refreshes the session when the access token has expired.
  try {
    await supabase.auth.getUser()
  } catch {
    // An unreachable auth server must not block the page; the client retries on its own.
  }
  return response
}

export const config = {
  matcher: [
    // Everything except static assets, the server tier, association files and the manifest.
    '/((?!_next/static|_next/image|favicon\\.ico|api/|\\.well-known/|manifest\\.webmanifest).*)',
  ],
}
