import type { NextConfig } from 'next'

/** Workspace packages ship TypeScript source; Next compiles them in place (ARCHITECTURE.md §3). */
const EARTH_PACKAGES = [
  '@earth/analytics',
  '@earth/api',
  '@earth/auth',
  '@earth/config',
  '@earth/domain',
  '@earth/observability',
  '@earth/permissions',
  '@earth/realtime',
  '@earth/server',
  '@earth/ui',
] as const

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  transpilePackages: [...EARTH_PACKAGES],
  /**
   * Spec §112: `https://earth.social/@handle`. Next cannot name a folder `@[handle]`, so the
   * public path is served by `app/u/[handle]`; links always use the `/@handle` form.
   */
  async rewrites() {
    return [{ source: '/@:handle', destination: '/u/:handle' }]
  },
  /** Spec §112: Apple reads the extensionless association file only as JSON. */
  async headers() {
    return [
      {
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'content-type', value: 'application/json' }],
      },
    ]
  },
}

export default nextConfig
