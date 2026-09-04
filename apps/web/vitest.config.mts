import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { defineConfig } from 'vitest/config'

/**
 * Component tests render with the React that Next ships (`next/dist/compiled/react*`): the
 * hoisted workspace holds two `react` versions (Expo's at the root, this app's here) and one
 * `react-dom`, so resolving them freely would pair a renderer with the wrong React.
 */
const require = createRequire(import.meta.url)
const compiled = dirname(require.resolve('next/package.json')) + '/dist/compiled'

export default defineConfig({
  // `tsconfig.json` keeps `jsx: preserve` for Next; tests compile TSX with the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${compiled}/react/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${compiled}/react/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${compiled}/react/jsx-dev-runtime.js` },
      { find: /^react-dom$/, replacement: `${compiled}/react-dom/index.js` },
      { find: /^react-dom\/server$/, replacement: `${compiled}/react-dom/server.node.js` },
    ],
  },
  test: {
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
    environment: 'node',
  },
})
