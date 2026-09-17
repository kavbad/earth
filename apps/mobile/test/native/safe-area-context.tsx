/** The `react-native-safe-area-context` test double: zero insets, providers pass children through. */
import { type ComponentType, type ReactNode } from 'react'

type AnyProps = Record<string, unknown> & { children?: ReactNode }

const host = (name: string): ComponentType<AnyProps> => name as unknown as ComponentType<AnyProps>

export const useSafeAreaInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 })
export const useSafeAreaFrame = () => ({ x: 0, y: 0, width: 390, height: 844 })
export const SafeAreaProvider = host('SafeAreaProvider')
export const SafeAreaView = host('SafeAreaView')
export const initialWindowMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
}
