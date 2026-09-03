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
}

export default nextConfig
