import { describe, expect, it } from 'vitest'

import {
  EM_DASH_SEPARATOR,
  SPELLED_NAMES_MAX,
  cleanNames,
  compactCount,
  formatHandle,
  initials,
  joinNames,
  joinWithDash,
  mutualLine,
  namesWithPlus,
  participantSummary,
  pluralWord,
  pluralize,
  relativeTime,
} from './format'

describe('relativeTime', () => {
  // Local-time constructor so weekday/month names do not depend on the machine time zone.
  const now = new Date(2026, 2, 10, 12, 0, 0) // Tue Mar 10 2026 12:00 local

  it('renders "now" under a minute and for future dates', () => {
    expect(relativeTime(now, now)).toBe('now')
    expect(relativeTime(new Date(now.getTime() - 59_000), now)).toBe('now')
    expect(relativeTime(new Date(now.getTime() + 60_000), now)).toBe('now')
  })

  it('renders minutes and hours', () => {
    expect(relativeTime(new Date(now.getTime() - 60_000), now)).toBe('1m')
    expect(relativeTime(new Date(now.getTime() - 3 * 60_000), now)).toBe('3m')
    expect(relativeTime(new Date(now.getTime() - 59 * 60_000), now)).toBe('59m')
    expect(relativeTime(new Date(now.getTime() - 3_600_000), now)).toBe('1h')
    expect(relativeTime(new Date(now.getTime() - 2 * 3_600_000), now)).toBe('2h')
    expect(relativeTime(new Date(now.getTime() - 23 * 3_600_000), now)).toBe('23h')
  })

  it('renders a weekday within six days, never today’s weekday', () => {
    expect(relativeTime(new Date(2026, 2, 9, 12), now)).toBe('Mon')
    expect(relativeTime(new Date(2026, 2, 8, 12), now)).toBe('Sun')
    expect(relativeTime(new Date(2026, 2, 5, 12), now)).toBe('Thu')
    expect(relativeTime(new Date(2026, 2, 4, 12, 0, 1), now)).toBe('Wed')
  })

  it('renders month and day beyond that, with the year when it differs', () => {
    expect(relativeTime(new Date(2026, 2, 4, 12), now)).toBe('Mar 4')
    expect(relativeTime(new Date(2026, 0, 1), now)).toBe('Jan 1')
    expect(relativeTime(new Date(2025, 11, 25), now)).toBe('Dec 25, 2025')
  })

  it('accepts ISO strings and epoch numbers', () => {
    const iso = new Date(now.getTime() - 5 * 60_000).toISOString()
    expect(relativeTime(iso, now.getTime())).toBe('5m')
  })

  it('formats calendar parts in UTC when asked', () => {
    const utcNow = Date.UTC(2026, 2, 10, 12)
    expect(relativeTime(Date.UTC(2026, 2, 8, 12), utcNow, { utc: true })).toBe('Sun')
    expect(relativeTime(Date.UTC(2025, 11, 25), utcNow, { utc: true })).toBe('Dec 25, 2025')
  })

  it('returns an empty string for invalid dates', () => {
    expect(relativeTime('not a date', now)).toBe('')
    expect(relativeTime(now, Number.NaN)).toBe('')
  })
})

describe('plurals', () => {
  it('pluralWord', () => {
    expect(pluralWord(1, 'room')).toBe('room')
    expect(pluralWord(0, 'room')).toBe('rooms')
    expect(pluralWord(3, 'person', 'people')).toBe('people')
  })

  it('pluralize', () => {
    expect(pluralize(1, 'mutual friend')).toBe('1 mutual friend')
    expect(pluralize(8, 'mutual friend')).toBe('8 mutual friends')
    expect(pluralize(11, 'person', 'people')).toBe('11 people')
  })
})

describe('compactCount', () => {
  it('formats thousands and millions compactly', () => {
    expect(compactCount(0)).toBe('0')
    expect(compactCount(999)).toBe('999')
    expect(compactCount(1000)).toBe('1k')
    expect(compactCount(1200)).toBe('1.2k')
    expect(compactCount(9999)).toBe('9.9k')
    expect(compactCount(15_300)).toBe('15k')
    expect(compactCount(999_999)).toBe('999k')
    expect(compactCount(1_200_000)).toBe('1.2M')
    expect(compactCount(12_000_000)).toBe('12M')
  })

  it('handles negatives, fractions and non-finite input', () => {
    expect(compactCount(-1200)).toBe('-1.2k')
    expect(compactCount(-1)).toBe('-1')
    expect(compactCount(-0.5)).toBe('0')
    expect(compactCount(0.9)).toBe('0')
    expect(compactCount(Number.NaN)).toBe('0')
    expect(compactCount(Number.POSITIVE_INFINITY)).toBe('0')
  })
})

describe('cleanNames', () => {
  it('trims and drops blank names', () => {
    expect(cleanNames([' Maya ', '', '  ', 'Xavier'])).toEqual(['Maya', 'Xavier'])
  })
})

describe('joinNames', () => {
  it('collapses the tail into "+ N others"', () => {
    expect(joinNames(['Maya', 'Xavier', 'A', 'B', 'C', 'D', 'E'], 2)).toBe(
      'Maya, Xavier + 5 others',
    )
    expect(joinNames(['Maya', 'Xavier', 'A'], 2)).toBe('Maya, Xavier + 1 other')
    expect(joinNames(['Maya', 'Xavier'], 2)).toBe('Maya, Xavier')
    expect(joinNames(['Maya'], 2)).toBe('Maya')
  })

  it('spells out two names by default and uses a total when names are only a sample', () => {
    expect(SPELLED_NAMES_MAX).toBe(2)
    expect(joinNames(['Maya', 'Xavier', 'Sam'])).toBe('Maya, Xavier + 1 other')
    expect(joinNames(['Maya', 'Xavier'], 2, 7)).toBe('Maya, Xavier + 5 others')
    expect(joinNames([], 2, 4)).toBe('4 people')
    expect(joinNames([], 2, 1)).toBe('1 person')
    expect(joinNames([], 2)).toBe('')
    expect(joinNames([' Maya '], 2)).toBe('Maya')
  })
})

describe('participantSummary', () => {
  it('renders the invite preview participants exactly like spec §46', () => {
    expect(participantSummary(['Maya', 'Xavier'], 7)).toBe('Maya, Xavier + 5 others')
    // The server sends a 3-name sample; the text still spells out two, like the spec example.
    expect(participantSummary(['Maya', 'Xavier', 'Sam'], 7)).toBe('Maya, Xavier + 5 others')
    expect(participantSummary(['Maya', 'Xavier', 'Sam'], 7, 3)).toBe('Maya, Xavier, Sam + 4 others')
    expect(participantSummary(['Maya'], 1)).toBe('Maya')
    expect(participantSummary([], 0)).toBe('')
  })
})

describe('namesWithPlus', () => {
  it('joins two names with a plus (Live titles)', () => {
    expect(namesWithPlus(['Xavier'])).toBe('Xavier')
    expect(namesWithPlus(['Xavier', 'Kavon'])).toBe('Xavier + Kavon')
    expect(namesWithPlus(['Xavier', 'Maya'])).toBe('Xavier + Maya')
  })

  it('collapses extra people into a bare count', () => {
    expect(namesWithPlus(['Xavier', 'Maya', 'Sam', 'Ben'])).toBe('Xavier, Maya + 2')
    expect(namesWithPlus(['Xavier', 'Maya', 'Sam'])).toBe('Xavier, Maya + 1')
    expect(namesWithPlus(['Maya'], { total: 3 })).toBe('Maya + 2')
    expect(namesWithPlus(['Xavier', 'Maya'], { total: 4 })).toBe('Xavier, Maya + 2')
  })

  it('respects max, trims names and ignores blank ones', () => {
    expect(namesWithPlus(['Xavier', 'Maya', 'Sam'], { max: 3 })).toBe('Xavier, Maya + Sam')
    expect(namesWithPlus(['Xavier', 'Maya', 'Sam'], { max: 0 })).toBe('3 people')
    expect(namesWithPlus(['Xavier', ' ', 'Maya'])).toBe('Xavier + Maya')
    expect(namesWithPlus([' Xavier ', 'Maya '])).toBe('Xavier + Maya')
    expect(namesWithPlus([], { total: 3 })).toBe('3 people')
    expect(namesWithPlus([], { total: 1 })).toBe('1 person')
    expect(namesWithPlus([])).toBe('')
    expect(namesWithPlus(['  '])).toBe('')
  })

  it('never counts fewer people than it names', () => {
    expect(namesWithPlus(['Xavier', 'Maya'], { total: 1 })).toBe('Xavier + Maya')
  })
})

describe('joinWithDash', () => {
  it('joins with a spaced em dash and drops blank sides', () => {
    expect(EM_DASH_SEPARATOR).toBe(' — ')
    expect(joinWithDash('Weekend Crew', 'Maya, Xavier + 5 others')).toBe(
      'Weekend Crew — Maya, Xavier + 5 others',
    )
    expect(joinWithDash('College', 'Maya + 2 live')).toBe('College — Maya + 2 live')
    expect(joinWithDash('Alex followed you', '')).toBe('Alex followed you')
    expect(joinWithDash('', 'Maya, Xavier + 5 others')).toBe('Maya, Xavier + 5 others')
    expect(joinWithDash('  ', '  ')).toBe('')
  })
})

describe('mutualLine', () => {
  it('renders mutual count and city with a middle dot', () => {
    expect(mutualLine(8, 'San Francisco')).toBe('8 mutual friends · San Francisco')
    expect(mutualLine(1, 'Oakland')).toBe('1 mutual friend · Oakland')
    expect(mutualLine(8)).toBe('8 mutual friends')
    expect(mutualLine(0, 'San Francisco')).toBe('San Francisco')
    expect(mutualLine(0, null)).toBe('')
    expect(mutualLine(0, '  ')).toBe('')
  })
})

describe('initials', () => {
  it('takes the first letters of the first and last words', () => {
    expect(initials('Kavon Badie')).toBe('KB')
    expect(initials('Xavier')).toBe('X')
    expect(initials('  maya   angelou  ')).toBe('MA')
    expect(initials('Jean Luc Picard')).toBe('JP')
    expect(initials('@maya')).toBe('M')
    expect(initials('')).toBe('')
    expect(initials('Élodie Durand')).toBe('ÉD')
  })
})

describe('formatHandle', () => {
  it('prefixes @ once and renders nothing for a blank handle', () => {
    expect(formatHandle('maya')).toBe('@maya')
    expect(formatHandle('@maya')).toBe('@maya')
    expect(formatHandle('@@maya')).toBe('@maya')
    expect(formatHandle(' maya ')).toBe('@maya')
    expect(formatHandle('')).toBe('')
    expect(formatHandle('  ')).toBe('')
    expect(formatHandle('@')).toBe('')
  })
})
