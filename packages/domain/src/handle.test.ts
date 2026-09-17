import { describe, expect, it } from 'vitest'

import { HANDLE_MAX_LENGTH } from './constants'
import {
  firstAvailableHandle,
  handleBaseFor,
  handleCandidates,
  handleValidationError,
  isValidHandle,
  normalizeHandle,
  suggestHandle,
} from './handle'

describe('normalizeHandle', () => {
  it('lowercases, strips @, folds diacritics and separators', () => {
    expect(normalizeHandle('@Maya')).toBe('maya')
    expect(normalizeHandle('  José Álvarez ')).toBe('jose_alvarez')
    expect(normalizeHandle('xavier.k-1')).toBe('xavier_k_1')
    expect(normalizeHandle('__weird__name__')).toBe('weird_name')
    expect(normalizeHandle('🌍 earth')).toBe('earth')
  })
})

describe('isValidHandle / handleValidationError', () => {
  it('accepts valid handles', () => {
    expect(isValidHandle('maya')).toBe(true)
    expect(isValidHandle('kavon_b2')).toBe(true)
    expect(handleValidationError('maya')).toBeNull()
  })

  it('explains invalid ones', () => {
    expect(handleValidationError('ma')).toBe('too_short')
    expect(handleValidationError('a'.repeat(25))).toBe('too_long')
    expect(handleValidationError('1maya')).toBe('invalid_start')
    expect(handleValidationError('_maya')).toBe('invalid_start')
    expect(handleValidationError('Maya')).toBe('invalid_chars')
    expect(handleValidationError('ma ya')).toBe('invalid_chars')
  })
})

describe('suggestHandle', () => {
  it('is deterministic: base then numeric suffixes starting at 2', () => {
    expect(suggestHandle('Maya')).toBe('maya')
    expect(suggestHandle('Maya', 0)).toBe('maya')
    expect(suggestHandle('Maya', 1)).toBe('maya2')
    expect(suggestHandle('Maya', 2)).toBe('maya3')
    expect(handleCandidates('Xavier Kim', 3)).toEqual(['xavier_kim', 'xavier_kim2', 'xavier_kim3'])
  })

  it('always yields a valid handle, including for awkward names', () => {
    const names = [
      'Maya',
      'Xavier Kim',
      '42',
      '__',
      '',
      '🌍🌎🌏',
      'A',
      '李小龙',
      'José',
      'Very Long Display Name That Exceeds The Limit Easily',
      '-_-',
      '9lives',
    ]
    for (const name of names) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const handle = suggestHandle(name, attempt)
        expect(
          isValidHandle(handle),
          `${JSON.stringify(name)} attempt ${attempt} → ${handle}`,
        ).toBe(true)
      }
    }
  })

  it('falls back to human when nothing usable remains and pads short bases', () => {
    expect(handleBaseFor('🌍🌎🌏')).toBe('human')
    expect(handleBaseFor('42')).toBe('human')
    expect(handleBaseFor('A')).toBe('a__')
    expect(handleBaseFor('9lives')).toBe('lives')
  })

  it('keeps suffixed suggestions within the maximum length', () => {
    const long = 'abcdefghijklmnopqrstuvwxyz'
    expect(suggestHandle(long)).toHaveLength(HANDLE_MAX_LENGTH)
    expect(suggestHandle(long, 1)).toHaveLength(HANDLE_MAX_LENGTH)
    expect(suggestHandle(long, 1).endsWith('2')).toBe(true)
    expect(suggestHandle(long, 1000)).toHaveLength(HANDLE_MAX_LENGTH)
    expect(suggestHandle(long, 1000).endsWith('1001')).toBe(true)
  })

  it('firstAvailableHandle walks the candidates', () => {
    const taken = new Set(['maya', 'maya2'])
    expect(firstAvailableHandle('Maya', (h) => taken.has(h))).toBe('maya3')
    expect(firstAvailableHandle('Maya', () => true, 5)).toBeNull()
  })
})
