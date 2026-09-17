import { copy } from '@earth/ui'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = { title: copy.settings.title }

export default function SettingsLayout({ children }: { readonly children: ReactNode }) {
  return children
}
