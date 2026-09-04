import { copy } from '@earth/ui'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = { title: copy.tabs.earth }

/** SCREEN 20 lives inside the member shell; the map itself fills what the shell leaves. */
export default function EarthLayout({ children }: { readonly children: ReactNode }) {
  return children
}
