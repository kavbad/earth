import type { ReactNode } from 'react'

import { AppShell } from '../../../components/shell/AppShell'

/** A post link opens inside the member shell (Visitors see the public World navigation). */
export default function PostLayout({ children }: { readonly children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}
