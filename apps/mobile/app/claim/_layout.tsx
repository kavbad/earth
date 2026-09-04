import { colors, motion } from '@earth/ui'
import { Stack } from 'expo-router'

import { ClaimFlowProvider } from '@/components/claim/ClaimFlowProvider'

/** Spec §44–§48: the claim flow lives outside the tabs; every step is a screen of this stack. */
export default function ClaimLayout() {
  return (
    <ClaimFlowProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'fade',
          animationDuration: motion.duration.fast,
        }}
      />
    </ClaimFlowProvider>
  )
}
