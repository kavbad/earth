/**
 * The `react-native-reanimated` test double: motion is a device concern, so timings resolve to
 * their target value immediately and animated styles are computed once per render. The animated
 * views stay host components (`Animated.View`), so a test still sees what is on screen.
 */
import { type ComponentType, type ReactNode, useState } from 'react'

type AnyProps = Record<string, unknown> & { children?: ReactNode }

const host = (name: string): ComponentType<AnyProps> => name as unknown as ComponentType<AnyProps>

export interface SharedValue<T> {
  value: T
}

/** A stable mutable box, like the real shared value: writing to it never re-renders. */
export const useSharedValue = <T,>(initial: T): SharedValue<T> => {
  const [shared] = useState<SharedValue<T>>(() => ({ value: initial }))
  return shared
}

export const useAnimatedStyle = (factory: () => object): object => factory()

export const withTiming = <T,>(to: T): T => to
export const withSpring = <T,>(to: T): T => to
export const withRepeat = <T,>(animation: T): T => animation
export const withDelay = <T,>(_delay: number, animation: T): T => animation
export const cancelAnimation = (): void => undefined
export const runOnJS =
  <A extends readonly unknown[], R>(fn: (...args: A) => R) =>
  (...args: A): R =>
    fn(...args)
export const runOnUI =
  <A extends readonly unknown[], R>(fn: (...args: A) => R) =>
  (...args: A): R =>
    fn(...args)

const bezier = () => (t: number) => t

export const Easing = {
  bezier,
  linear: (t: number) => t,
  ease: (t: number) => t,
  in: bezier,
  out: bezier,
  inOut: bezier,
}

/** Entering / exiting animations: chainable builders that never change what renders. */
class Entry {
  duration(): this {
    return this
  }
  delay(): this {
    return this
  }
  springify(): this {
    return this
  }
  static duration(): Entry {
    return new Entry()
  }
  static delay(): Entry {
    return new Entry()
  }
}

export const FadeIn = new Entry()
export const FadeOut = new Entry()
export const FadeInDown = new Entry()
export const FadeOutDown = new Entry()

const Animated = {
  View: host('Animated.View'),
  Text: host('Animated.Text'),
  ScrollView: host('Animated.ScrollView'),
  Image: host('Animated.Image'),
  createAnimatedComponent: <P,>(component: ComponentType<P>): ComponentType<P> => component,
}

export default Animated
