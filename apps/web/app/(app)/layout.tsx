import type { ReactNode } from 'react'

import { AppShell } from '../../components/shell/AppShell'

/** The member shell: Home · Chats · Live · Earth · You (spec §50). */
export default function AppLayout({ children }: { readonly children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}
