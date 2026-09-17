/** The `react-native-svg` test double: host elements that keep the icon path data in the tree. */
import { type ComponentType, type ReactNode } from 'react'

type AnyProps = Record<string, unknown> & { children?: ReactNode }

const host = (name: string): ComponentType<AnyProps> => name as unknown as ComponentType<AnyProps>

export const Path = host('Path')
export const Circle = host('Circle')
export const Rect = host('Rect')
export const G = host('G')
export const Defs = host('Defs')
export const ClipPath = host('ClipPath')

const Svg = host('Svg')
export default Svg
