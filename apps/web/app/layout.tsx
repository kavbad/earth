import { APP_NAME, colors } from '@earth/ui'
import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import { EarthProviders } from '../lib/providers'

import './globals.css'

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: 'Earth — real Humans, groups, private conversation and Live video around you.',
  applicationName: 'Earth',
  manifest: '/manifest.webmanifest',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: colors.background,
  colorScheme: 'light',
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-background font-system text-body text-text-primary antialiased">
        <EarthProviders>{children}</EarthProviders>
      </body>
    </html>
  )
}
