/**
 * When the map may be handed to the screen: its style loaded, its style failed, or the deadline
 * passed — whichever happens first.
 *
 * A style host that answers slowly, or never, raises neither `load` nor `error`, so waiting on
 * those two alone can wait forever. Nothing downstream tolerates that: until the wait ends there is
 * no map, so no camera, so no `map_objects` request, and Earth shows no one at all (E2E 10). The
 * camera is valid from construction, so carrying on without the basemap costs only the tiles, and
 * those still appear if the style arrives later.
 */
export const STYLE_READY_TIMEOUT_MS = 5_000

/** The part of a MapLibre map this rule needs, so it can be tested without the vendor. */
export interface StyleReadySource {
  readonly loaded: () => boolean
  readonly once: (event: 'load' | 'error', handler: () => void) => unknown
}

export function whenStyleReady(
  map: StyleReadySource,
  timeoutMs: number = STYLE_READY_TIMEOUT_MS,
): Promise<void> {
  if (map.loaded()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs)
    const settle = (): void => {
      clearTimeout(timer)
      resolve()
    }
    map.once('load', settle)
    map.once('error', settle)
  })
}
