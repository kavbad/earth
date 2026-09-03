import { describe, expect, it } from 'vitest'

import { PACKAGE_NAME } from './index'

describe('@earth/api', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@earth/api')
  })
})
