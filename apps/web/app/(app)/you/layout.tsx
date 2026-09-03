import { copy } from '@earth/ui'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = { title: copy.tabs.you }

export default function YouLayout({ children }: { readonly children: ReactNode }) {
  return children
}
