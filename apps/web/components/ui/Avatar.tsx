/* eslint-disable @next/next/no-img-element -- avatars come from many hosts; no optimisation layer */
import { type AvatarSizeName, avatarSize, initials } from '@earth/ui'

import { cx } from './cx'

export interface AvatarProps {
  readonly name: string
  readonly src?: string | null
  readonly size?: AvatarSizeName
  /** Marks the person as currently Live with the small red dot (spec §92 — never a border). */
  readonly live?: boolean
  /** When the name is already visible next to the avatar, hide it from assistive tech. */
  readonly decorative?: boolean
  readonly className?: string | undefined
}

const FONT_CLASS: Record<AvatarSizeName, string> = {
  small: 'text-meta',
  medium: 'text-secondary font-medium',
  large: 'text-section',
  profile: 'text-title',
}

export function Avatar({
  name,
  src,
  size = 'medium',
  live = false,
  decorative = false,
  className,
}: AvatarProps) {
  const px = avatarSize[size]
  const label = decorative ? undefined : name
  return (
    <span
      className={cx('relative inline-block shrink-0 align-middle', className)}
      style={{ width: px, height: px }}
    >
      {src ? (
        <img
          src={src}
          alt={label ?? ''}
          width={px}
          height={px}
          loading="lazy"
          className="size-full rounded-avatar bg-subtle-fill object-cover"
        />
      ) : (
        <span
          role={decorative ? undefined : 'img'}
          aria-label={label}
          aria-hidden={decorative || undefined}
          className={cx(
            'flex size-full items-center justify-center rounded-avatar bg-subtle-fill text-text-secondary select-none',
            FONT_CLASS[size],
          )}
        >
          {initials(name)}
        </span>
      )}
      {live ? (
        <span
          aria-hidden="true"
          className="absolute right-0 bottom-0 size-2 rounded-avatar bg-live ring-2 ring-background"
        />
      ) : null}
    </span>
  )
}
