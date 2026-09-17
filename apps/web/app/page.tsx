import { redirect } from 'next/navigation'

import { ROUTES } from '../lib/routes'

/** `/` is Home: the public World for Visitors, the person's radius for Humans (SCREEN 01/02). */
export default function RootPage() {
  redirect(ROUTES.home)
}
