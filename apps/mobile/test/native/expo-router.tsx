/**
 * The `expo-router` test double. Navigation is a device concern; the router here only records
 * where a screen tried to go, so a test can assert the destination without a navigation container.
 */
import { type ComponentType, type ReactNode } from 'react'

type AnyProps = Record<string, unknown> & { children?: ReactNode }

const host = (name: string): ComponentType<AnyProps> => name as unknown as ComponentType<AnyProps>

export interface RouterCall {
  readonly method: 'push' | 'replace' | 'navigate' | 'back' | 'dismiss' | 'setParams'
  readonly to: unknown
}

/** Every navigation attempted during the current test, in order. `resetRouter()` clears it. */
export const routerCalls: RouterCall[] = []

export const resetRouter = (): void => {
  routerCalls.length = 0
}

const record =
  (method: RouterCall['method']) =>
  (to?: unknown): void => {
    routerCalls.push({ method, to: to ?? null })
  }

const router = {
  push: record('push'),
  replace: record('replace'),
  navigate: record('navigate'),
  back: record('back'),
  dismiss: record('dismiss'),
  dismissAll: record('dismiss'),
  setParams: record('setParams'),
  canGoBack: () => false,
}

export const useRouter = () => router
export const useLocalSearchParams = <T extends object = Record<string, string>>(): T => ({}) as T
export const useGlobalSearchParams = <T extends object = Record<string, string>>(): T => ({}) as T
export const usePathname = () => '/'
export const useSegments = (): string[] => []
export const useFocusEffect = (): void => undefined
export const Link = host('Link')
export const Redirect = host('Redirect')
export const Slot = host('Slot')

const Stack = Object.assign(host('Stack'), { Screen: host('Stack.Screen') })
const Tabs = Object.assign(host('Tabs'), { Screen: host('Tabs.Screen') })
export { Stack, Tabs }

export const SplashScreen = {
  preventAutoHideAsync: () => Promise.resolve(true),
  hideAsync: () => Promise.resolve(true),
  setOptions: () => undefined,
}
