import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { copy } from '@earth/ui'

import { ClaimFlowProvider } from './_components/ClaimFlowProvider'
import { ClaimFrame } from './_components/ClaimFrame'

export const metadata: Metadata = { title: copy.claimYourPlace }

export default function ClaimLayout({ children }: { readonly children: ReactNode }) {
  return (
    <ClaimFlowProvider>
      <ClaimFrame>{children}</ClaimFrame>
    </ClaimFlowProvider>
  )
}
