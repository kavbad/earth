'use client'

/**
 * SCREEN 13 — Live Home: the same radius control as Home and Earth, then a clean list of Lives
 * named for the viewer. No autoplay, no full-screen swipe mode in V1.
 */
import { copy } from '@earth/ui'

import { LiveList } from '../../../components/live/LiveList'
import { PageContainer } from '../../../components/shell/PageContainer'
import { RadiusControl } from '../../../components/shell/RadiusControl'
import { ScreenHeader } from '../../../components/shell/ScreenHeader'

export default function LivePage() {
  return (
    <>
      <ScreenHeader title={copy.tabs.live}>
        <RadiusControl surface="live" />
      </ScreenHeader>
      <PageContainer>
        <LiveList />
      </PageContainer>
    </>
  )
}
