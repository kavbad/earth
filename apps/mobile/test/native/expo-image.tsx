/** The `expo-image` test double: a host `Image` that keeps `source`, `contentFit` and labels. */
import { type ComponentType, type ReactNode } from 'react'

type AnyProps = Record<string, unknown> & { children?: ReactNode }

export const Image = 'Image' as unknown as ComponentType<AnyProps>
export const ImageBackground = 'ImageBackground' as unknown as ComponentType<AnyProps>
