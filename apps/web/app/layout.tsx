import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { APP_NAME } from '@earth/ui'

import './globals.css'

export const metadata: Metadata = {
  title: APP_NAME,
  description: 'Earth — real Humans, groups, private conversation and Live video around you.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          backgroundColor: '#ffffff',
          color: '#111111',
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          WebkitFontSmoothing: 'antialiased',
        }}
      >
        {children}
      </body>
    </html>
  )
}
