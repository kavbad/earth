import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * React Native ships Flow source and a native runtime, so `react-native` and the Expo/native
 * modules cannot be imported by Vitest. `test/native/*` holds a host-component double for each one,
 * and the aliases below are what let a `.test.tsx` mount a real screen through `test/render.tsx`.
 * Nothing outside the tests sees them — Metro always bundles the real modules.
 */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  // `expo/tsconfig.base` sets `jsx: react-jsx`; keep the transform on the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${here('.')}/` },
      { find: /^react-native$/, replacement: here('./test/native/react-native.tsx') },
      { find: /^react-native-reanimated$/, replacement: here('./test/native/reanimated.tsx') },
      {
        find: /^react-native-safe-area-context$/,
        replacement: here('./test/native/safe-area-context.tsx'),
      },
      { find: /^react-native-svg$/, replacement: here('./test/native/svg.tsx') },
      { find: /^expo-router$/, replacement: here('./test/native/expo-router.tsx') },
      { find: /^expo-haptics$/, replacement: here('./test/native/expo-haptics.ts') },
      { find: /^expo-secure-store$/, replacement: here('./test/native/expo-secure-store.ts') },
      { find: /^expo-image$/, replacement: here('./test/native/expo-image.tsx') },
      { find: /^expo-av$/, replacement: here('./test/native/expo-av.tsx') },
      { find: /^expo-image-picker$/, replacement: here('./test/native/expo-image-picker.ts') },
      { find: /^expo-file-system$/, replacement: here('./test/native/expo-file-system.ts') },
      {
        find: /^@react-native-async-storage\/async-storage$/,
        replacement: here('./test/native/async-storage.ts'),
      },
      { find: /^@sentry\/react-native$/, replacement: here('./test/native/sentry.ts') },
    ],
  },
  test: {
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.expo/**', '.expo-export-check/**', 'ios/**', 'android/**'],
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
  },
})
