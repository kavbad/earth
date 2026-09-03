import type { ReactNode } from 'react'

import { AppShell } from '../../../components/shell/AppShell'

/** `/@handle` (rewritten here) opens inside the member shell. */
export default function ProfileLayout({ children }: { readonly children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}
