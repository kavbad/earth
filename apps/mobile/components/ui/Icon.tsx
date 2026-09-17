/**
 * Icons from the shared path data (`@earth/ui`), painted with one color. Decorative unless a
 * `label` is given.
 */
import {
  ICON_LINECAP,
  ICON_LINEJOIN,
  type IconName,
  type IconSizeName,
  colors,
  iconSize,
  icons,
} from '@earth/ui'
import Svg, { Path } from 'react-native-svg'

export interface IconProps {
  readonly name: IconName
  /** Token size; defaults to `base` (24). */
  readonly size?: IconSizeName
  readonly color?: string
  /** Accessible name; without one the icon is hidden from assistive tech. */
  readonly label?: string
}

export function Icon({ name, size = 'base', color = colors.textPrimary, label }: IconProps) {
  const def = icons[name]
  const px = iconSize[size]
  const accessibility =
    label === undefined
      ? { accessible: false, importantForAccessibility: 'no-hide-descendants' as const }
      : {
          accessible: true,
          accessibilityRole: 'image' as const,
          accessibilityLabel: label,
          importantForAccessibility: 'yes' as const,
        }
  return (
    <Svg viewBox={def.viewBox} width={px} height={px} {...accessibility}>
      {def.paths.map((path, index) =>
        path.kind === 'fill' ? (
          <Path key={index} d={path.d} fill={color} stroke="none" />
        ) : (
          <Path
            key={index}
            d={path.d}
            fill="none"
            stroke={color}
            strokeWidth={def.strokeWidth}
            strokeLinecap={ICON_LINECAP}
            strokeLinejoin={ICON_LINEJOIN}
          />
        ),
      )}
    </Svg>
  )
}
