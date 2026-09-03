'use client'

/**
 * SCREEN 04: the simple city switch — where the person is now, or their home city. Rendered as
 * the header's subtitle; a sheet lists the two.
 */
import type { AreaId } from '@earth/domain'
import { useState } from 'react'

import { Icon } from '../ui/Icon'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { feedCopy } from './copy'
import type { CityChoice } from './state/feed'

export interface CitySwitchProps {
  readonly choices: readonly CityChoice[]
  /** `null` = the current city. */
  readonly selected: AreaId | null
  /** The name the feed answered with, shown when no choice matches. */
  readonly fallbackName: string | null
  readonly onSelect: (areaId: AreaId | null) => void
}

export function selectedChoice(
  choices: readonly CityChoice[],
  selected: AreaId | null,
): CityChoice | undefined {
  return selected === null
    ? (choices.find((choice) => choice.kind === 'current') ?? choices[0])
    : choices.find((choice) => choice.areaId === selected)
}

export function CitySwitch({ choices, selected, fallbackName, onSelect }: CitySwitchProps) {
  const [open, setOpen] = useState(false)
  const current = selectedChoice(choices, selected)
  const name = current?.name ?? fallbackName
  if (choices.length < 2) {
    return name === null ? null : (
      <p className="truncate text-secondary text-text-secondary">{name}</p>
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${feedCopy.changeCity}: ${name ?? ''}`}
        className="-ml-1 inline-flex min-h-8 items-center gap-1 rounded-small px-1 text-secondary text-text-secondary transition-colors duration-fast ease-standard hover:text-text-primary"
      >
        <span className="truncate">{name ?? feedCopy.noCityYet}</span>
        <Icon name="chevron" size="small" className="rotate-90" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={feedCopy.cityTitle} closeButton>
        <List>
          {choices.map((choice) => {
            const active = current?.areaId === choice.areaId
            return (
              <ListRow
                key={choice.areaId}
                as="button"
                title={choice.name}
                subtitle={choice.kind === 'current' ? feedCopy.currentCity : feedCopy.homeCity}
                aria-pressed={active}
                trailing={active ? <Icon name="check" size="small" /> : undefined}
                onClick={() => {
                  onSelect(choice.kind === 'current' ? null : choice.areaId)
                  setOpen(false)
                }}
                className="px-0"
              />
            )
          })}
        </List>
      </Sheet>
    </>
  )
}
