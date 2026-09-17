import { cx } from './cx'

export interface SkeletonProps {
  readonly className?: string | undefined
}

/** A subtle placeholder block while cached content is on its way (never a whole-page error). */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx('skeleton-pulse block rounded-small bg-subtle-fill', className)}
    />
  )
}
