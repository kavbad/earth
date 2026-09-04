/**
 * "Bring them here" (spec §45 step 10, SCREEN 12 invite links): how an invite link leaves the
 * app, reduced to the `ShareChannel` of `group_invite_shared`. The system share sheet is the
 * primary way; the clipboard is the fallback when sharing is unavailable. Pure.
 */
import type { ShareChannel } from '@earth/analytics'

/** The shape `Share.share` resolves to (React Native), kept structural so it is testable. */
export interface ShareOutcome {
  readonly action: 'sharedAction' | 'dismissedAction'
}

/** `system_share` when the sheet reported a share; `null` when the person dismissed it. */
export function shareChannelFor(outcome: ShareOutcome): ShareChannel | null {
  return outcome.action === 'sharedAction' ? 'system_share' : null
}

/** After a failed share sheet: `copy_link` when the clipboard took the link, else `other`. */
export function fallbackShareChannel(copied: boolean): ShareChannel {
  return copied ? 'copy_link' : 'other'
}

export interface ShareInviteDeps {
  /** Opens the system share sheet with the link; rejects when sharing is unavailable. */
  share(url: string): Promise<ShareOutcome>
  /** Copies the link; resolves `false` when the clipboard is unavailable. */
  copy(url: string): Promise<boolean>
}

/**
 * Shares an invite link: the system sheet first, the clipboard when the sheet cannot open.
 * Resolves the channel to track, or `null` when the person changed their mind.
 */
export async function shareInviteLink(
  url: string,
  deps: ShareInviteDeps,
): Promise<ShareChannel | null> {
  try {
    return shareChannelFor(await deps.share(url))
  } catch {
    // Sharing unavailable on this device: fall back to the clipboard.
  }
  let copied = false
  try {
    copied = await deps.copy(url)
  } catch {
    copied = false
  }
  return fallbackShareChannel(copied)
}
