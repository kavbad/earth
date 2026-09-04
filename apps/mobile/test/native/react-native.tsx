/**
 * The `react-native` test double.
 *
 * React Native ships Flow source and a native runtime, so the real module cannot be imported by
 * Vitest (`vitest.config.mts` aliases this file in its place; Metro always bundles the real one).
 *
 * This double gives every primitive the screens use a *host* identity — react-test-renderer
 * records `type`, `props` and children verbatim — so a test asserts on the same tree the device
 * would build: `accessibilityLabel`, `accessibilityRole`, `accessibilityState`, `onPress`, copy.
 *
 * Only behavior that changes what renders is implemented (`Modal` honours `visible`, `FlatList`
 * renders its rows, `Pressable` resolves a function `style`); everything else is inert.
 */
import {
  type ComponentType,
  type ReactElement,
  type ReactNode,
  createElement,
  isValidElement,
} from 'react'

export type AnyProps = Record<string, unknown> & { children?: ReactNode }

/** A host component: react-test-renderer keeps the name and the props untouched. */
const host = (name: string): ComponentType<AnyProps> => name as unknown as ComponentType<AnyProps>

export const View = host('View')
export const Text = host('Text')
export const TextInput = host('TextInput')
export const Image = host('Image')
export const ScrollView = host('ScrollView')
export const KeyboardAvoidingView = host('KeyboardAvoidingView')
export const SafeAreaView = host('SafeAreaView')
export const ActivityIndicator = host('ActivityIndicator')
export const Switch = host('Switch')
export const RefreshControl = host('RefreshControl')
export const TouchableOpacity = host('TouchableOpacity')
export const SectionList = host('SectionList')

interface PressableProps extends Omit<AnyProps, 'children'> {
  readonly style?: unknown
  readonly children?: ReactNode | ((state: { pressed: boolean }) => ReactNode)
}

/** Resolves the `({ pressed }) => style` form so a test never sees a function in `style`. */
export function Pressable({ style, children, ...rest }: PressableProps): ReactElement {
  const resolved =
    typeof style === 'function' ? (style as (s: object) => unknown)({ pressed: false }) : style
  const body = typeof children === 'function' ? children({ pressed: false }) : children
  return createElement('Pressable', { ...rest, style: resolved }, body)
}

interface ModalProps extends AnyProps {
  readonly visible?: boolean
}

/** A hidden modal renders nothing, exactly as on the device. */
export function Modal({ visible = true, children, ...rest }: ModalProps): ReactElement | null {
  if (!visible) return null
  return createElement('Modal', rest, children)
}

type Renderable = ReactNode | ComponentType<AnyProps>

const node = (value: Renderable | undefined | null): ReactNode => {
  if (value === null || value === undefined) return null
  if (isValidElement(value)) return value
  if (typeof value === 'function') return createElement(value as ComponentType<AnyProps>, {})
  return value as ReactNode
}

interface FlatListProps<T> extends Omit<AnyProps, 'children'> {
  readonly data?: readonly T[] | null | undefined
  readonly renderItem?: ((info: { item: T; index: number; separators: object }) => ReactNode) | null
  readonly keyExtractor?: ((item: T, index: number) => string) | undefined
  readonly ListHeaderComponent?: Renderable | undefined
  readonly ListFooterComponent?: Renderable | undefined
  readonly ListEmptyComponent?: Renderable | undefined
  readonly ItemSeparatorComponent?: ComponentType<AnyProps> | null | undefined
}

const SEPARATORS = {
  highlight: () => undefined,
  unhighlight: () => undefined,
  updateProps: () => undefined,
}

/** Renders every row (and the header / footer / empty / separator slots) instead of virtualizing. */
export function FlatList<T>({
  data,
  renderItem,
  keyExtractor,
  ListHeaderComponent,
  ListFooterComponent,
  ListEmptyComponent,
  ItemSeparatorComponent,
  ...rest
}: FlatListProps<T>): ReactElement {
  const items = data ?? []
  const rows: ReactNode[] = []
  items.forEach((item, index) => {
    const key = keyExtractor?.(item, index) ?? String(index)
    if (index > 0 && ItemSeparatorComponent !== null && ItemSeparatorComponent !== undefined) {
      rows.push(createElement(ItemSeparatorComponent, { key: `${key}-separator` }))
    }
    rows.push(
      createElement(
        'FlatListItem',
        { key },
        renderItem?.({ item, index, separators: SEPARATORS }) ?? null,
      ),
    )
  })
  return createElement(
    'FlatList',
    rest,
    node(ListHeaderComponent),
    items.length === 0 ? node(ListEmptyComponent) : rows,
    node(ListFooterComponent),
  )
}

interface NamedStyles {
  readonly [key: string]: object
}

export const StyleSheet = {
  create: <T extends NamedStyles>(styles: T): T => styles,
  flatten: (style: unknown): object =>
    Array.isArray(style)
      ? style.reduce<object>((all, one) => ({ ...all, ...(StyleSheet.flatten(one) as object) }), {})
      : ((style as object | null | undefined) ?? {}),
  compose: (a: unknown, b: unknown): unknown[] => [a, b],
  hairlineWidth: 1,
  absoluteFill: {} as object,
  absoluteFillObject: {} as object,
}

export const Platform = {
  OS: 'ios' as const,
  Version: 18,
  isTV: false,
  select: <T,>(spec: { ios?: T; android?: T; native?: T; default?: T }): T | undefined =>
    spec.ios ?? spec.native ?? spec.default,
}

export const useWindowDimensions = () => ({ width: 390, height: 844, scale: 3, fontScale: 1 })

export const Dimensions = {
  get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  addEventListener: () => ({ remove: () => undefined }),
}

export const AppState = {
  currentState: 'active' as const,
  addEventListener: () => ({ remove: () => undefined }),
}

export const AccessibilityInfo = {
  isReduceMotionEnabled: () => Promise.resolve(false),
  isScreenReaderEnabled: () => Promise.resolve(false),
  announceForAccessibility: () => undefined,
  addEventListener: () => ({ remove: () => undefined }),
}

export const Linking = {
  openURL: () => Promise.resolve(),
  canOpenURL: () => Promise.resolve(true),
  getInitialURL: () => Promise.resolve(null),
  addEventListener: () => ({ remove: () => undefined }),
}

export const Share = {
  share: () => Promise.resolve({ action: 'sharedAction' as const }),
}

export const Keyboard = {
  dismiss: () => undefined,
  addListener: () => ({ remove: () => undefined }),
}

export const Alert = { alert: () => undefined }
