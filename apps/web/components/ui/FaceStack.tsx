import type { AvatarSizeName } from '@earth/ui'

import { Avatar } from './Avatar'
import { cx } from './cx'

export interface FaceStackPerson {
  readonly displayName: string
  readonly avatarUrl: string | null
}

export interface FaceStackProps {
  readonly people: readonly FaceStackPerson[]
  /** Faces shown before the rest collapses into `+N`. */
  readonly max?: number
  /** Total number of people when `people` is only a sample. */
  readonly total?: number
  readonly size?: AvatarSizeName
  /** Accessible summary for the whole stack (`Maya, Xavier + 5 others`). */
  readonly label: string
  readonly className?: string | undefined
}

/** Overlapping faces — the way Live and group previews say who is there (spec §92). */
export function FaceStack({
  people,
  max = 3,
  total,
  size = 'small',
  label,
  className,
}: FaceStackProps) {
  const shown = people.slice(0, max)
  const count = Math.max(total ?? people.length, shown.length)
  const rest = count - shown.length
  return (
    <span role="img" aria-label={label} className={cx('inline-flex items-center', className)}>
      {shown.map((person, index) => (
        <Avatar
          key={`${person.displayName}-${index}`}
          name={person.displayName}
          src={person.avatarUrl}
          size={size}
          decorative
          className={cx('rounded-avatar ring-2 ring-background', index > 0 && '-ml-2')}
        />
      ))}
      {rest > 0 ? (
        <span aria-hidden="true" className="ml-1.5 text-meta text-text-secondary">
          +{rest}
        </span>
      ) : null}
    </span>
  )
}
