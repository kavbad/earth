/**
 * Vitest setup for the mobile client. `act()` needs the React act environment flag, Metro's
 * `__DEV__` global has no bundler here, and the router double is reset between tests so one test
 * never reads another's navigation.
 */
import { afterEach } from 'vitest'

import { resetRouter } from './native/expo-router'

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; __DEV__?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { __DEV__?: boolean }).__DEV__ = false

afterEach(() => {
  resetRouter()
})
