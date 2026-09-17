import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { AppState } from 'react-native'

/** One `QueryClient` per process; cached reads stay visible while a refresh fails (spec §110). */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: 1,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: { retry: 0 },
    },
  })
}

export function QueryProvider({ children }: { readonly children: ReactNode }) {
  const [client] = useState(createQueryClient)

  // "Window focus" on a phone is the app returning to the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      focusManager.setFocused(status === 'active')
    })
    return () => subscription.remove()
  }, [])

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
