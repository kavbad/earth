'use client'

/**
 * The universal social-radius control (spec §51, §93): Friends · Neighborhood · City · World as a
 * text row. Visitors see World selected; tapping another radius opens the claim sheet.
 */
import { SCOPES, type Scope } from '@earth/domain'
import { copy } from '@earth/ui'

import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useScope } from '../../lib/providers/ScopeProvider'
import { type ScopeAvailability, type ScopeSurface } from '../../lib/scope/state'
import { type SegmentOption, SegmentedText } from '../ui/SegmentedText'
import { useClaimGate } from './ClaimSheet'

export interface RadiusControlViewProps {
  readonly value: Scope
  readonly availability: Readonly<Record<Scope, ScopeAvailability>>
  readonly onSelect: (scope: Scope) => void
  readonly className?: string | undefined
}

export function radiusOptions(
  availability: Readonly<Record<Scope, ScopeAvailability>>,
): ReadonlyArray<SegmentOption<Scope>> {
  return SCOPES.map((scope) => ({
    key: scope,
    label: copy.scopes[scope],
    state: availability[scope],
  }))
}

/** Presentational row; `RadiusControl` wires it to scope state, flags and the claim sheet. */
export function RadiusControlView({
  value,
  availability,
  onSelect,
  className,
}: RadiusControlViewProps) {
  return (
    <SegmentedText
      label={webCopy.radiusLabel}
      options={radiusOptions(availability)}
      value={value}
      onSelect={onSelect}
      className={className}
    />
  )
}

export interface RadiusControlProps {
  readonly surface: ScopeSurface
  readonly className?: string | undefined
}

export function RadiusControl({ surface, className }: RadiusControlProps) {
  const { scope, availability, setScope } = useScope(surface)
  const gate = useClaimGate()
  const analytics = useAnalytics()
  const onSelect = (next: Scope) => {
    const state = availability[next]
    if (state === 'disabled' || next === scope) return
    if (state === 'claim') {
      gate.open('public_world')
      return
    }
    analytics.track('scope_changed', { from: scope, to: next, surface })
    setScope(next)
  }
  return (
    <RadiusControlView
      value={scope}
      availability={availability}
      onSelect={onSelect}
      className={className}
    />
  )
}
