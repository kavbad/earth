/**
 * The header of a shell screen: the `earth` wordmark on Home (SCREEN 01/02: header `earth`) and
 * a large title on the other tab roots, over the primitives' `ScreenHeader`. Children sit under
 * it (the radius row of spec §51).
 */
import { APP_NAME } from '@earth/ui'

import { ScreenHeader, type ScreenHeaderProps } from '@/components/ui/ScreenHeader'

export interface ShellScreenHeaderProps extends Omit<ScreenHeaderProps, 'title' | 'large'> {
  readonly title?: string
  /** Render the lowercase `earth` wordmark instead of a title (Home). */
  readonly wordmark?: boolean
}

export function ShellScreenHeader({ wordmark = false, title, ...rest }: ShellScreenHeaderProps) {
  return <ScreenHeader title={wordmark ? APP_NAME : (title ?? '')} large {...rest} />
}

/** Home's header: the wordmark. */
export function HomeHeader(props: Omit<ShellScreenHeaderProps, 'wordmark' | 'title'>) {
  return <ShellScreenHeader wordmark {...props} />
}
