import { APP_NAME as PRODUCT_NAME } from '@earth/config'
import { colors } from '@earth/ui'
import type { MetadataRoute } from 'next'

import { ROUTES } from '../lib/routes'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    description: 'Real Humans, groups, private conversation and Live video around you.',
    start_url: ROUTES.home,
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: colors.background,
    theme_color: colors.background,
    icons: [],
  }
}
