/**
 * SCREEN 17 title for a room invite preview: the context ("Weekend Crew"), else the participant
 * line (`Xavier + Kavon are live`), else a plain "Live". Pure and shared by the server-rendered
 * page (`app/live/[token]`, metadata + heading) and the client flow (`GuestRoom`); it must not
 * live in a `'use client'` module, which the server cannot call.
 */
import type { RoomInvitePreviewDto } from '@earth/domain'
import { liveTitle } from '@earth/ui'

import { roomCopy } from '../copy'

export function previewTitle(preview: RoomInvitePreviewDto): string {
  if (preview.contextTitle !== null) return preview.contextTitle
  const names = preview.participants.map((p) => p.displayName)
  const title = liveTitle(names, preview.participants.length)
  return title === '' ? roomCopy.liveTitle : title
}
