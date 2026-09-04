/**
 * Back from a pushed screen: the previous screen when there is one (a deep link may have opened
 * the screen first), otherwise Home.
 */
import { useRouter } from 'expo-router'
import { useCallback } from 'react'

import { HOME_ROUTE } from '../routes'

export function useBack(): () => void {
  const router = useRouter()
  return useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace(HOME_ROUTE)
  }, [router])
}
