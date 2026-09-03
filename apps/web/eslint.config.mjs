import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

// The web app uses Next's flat config (React, hooks, a11y, TypeScript) on top of the
// repository conventions enforced by Prettier. Root eslint.config.js is not merged here
// because eslint-config-next registers the same plugins.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  prettier,
  globalIgnores(['.next/**', 'out/**', 'next-env.d.ts', 'coverage/**']),
])
