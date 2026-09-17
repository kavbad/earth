import { ICON_LINECAP, ICON_LINEJOIN, type IconName, iconSize as iconSizes, icons } from '@earth/ui'

export interface IconProps {
  readonly name: IconName
  /** Token size; defaults to `base` (24). */
  readonly size?: keyof typeof iconSizes
  /** Accessible name; without one the icon is decorative (`aria-hidden`). */
  readonly title?: string
  readonly className?: string | undefined
}

/** Inline SVG from the shared icon path data (`@earth/ui`), painted with `currentColor`. */
export function Icon({ name, size = 'base', title, className }: IconProps) {
  const def = icons[name]
  const px = iconSizes[size]
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={def.viewBox}
      width={px}
      height={px}
      className={className}
      {...(title === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': title })}
    >
      {def.paths.map((path, index) =>
        path.kind === 'fill' ? (
          <path key={index} d={path.d} fill="currentColor" stroke="none" />
        ) : (
          <path
            key={index}
            d={path.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={def.strokeWidth}
            strokeLinecap={ICON_LINECAP}
            strokeLinejoin={ICON_LINEJOIN}
          />
        ),
      )}
    </svg>
  )
}
