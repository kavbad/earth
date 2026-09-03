import { describe, expect, it } from 'vitest'

import { APP_NAME, PACKAGE_NAME } from './index'

describe('@earth/ui', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@earth/ui')
  })

  it('renders the wordmark lowercase', () => {
    expect(APP_NAME).toBe('earth')
    expect(APP_NAME).toBe(APP_NAME.toLowerCase())
  })
})
