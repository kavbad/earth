/**
 * Composer attachments (SCREEN 06): photos and videos from the in-app camera (provenance
 * `earth_capture`) or the library (`uploaded`), each uploading at once through `media.upload`
 * into the `media` bucket and becoming a `PostMediaArgs` for `post_create`. A row previews the
 * local file while it uploads; a failed upload can be removed.
 */
import { type PostMediaArgs, STORAGE_BUCKETS } from '@earth/api'
import * as ImagePicker from 'expo-image-picker'
import { useCallback, useEffect, useReducer, useRef } from 'react'

import { postCopy } from '../copy'
import { useFeedShell } from '../shell'
import {
  EMPTY_PENDING_MEDIA,
  type MediaSource,
  type PendingMedia,
  type PendingMediaState,
  type PickedMedia,
  isUploading,
  mediaRoom,
  pendingMediaReducer,
  pickedMediaFromAsset,
  readyMedia,
} from '../state/media'

export const PICKER_IMAGE_QUALITY = 0.85

export interface MediaUploads {
  readonly state: PendingMediaState
  readonly uploading: boolean
  readonly ready: readonly PostMediaArgs[]
  /** How many more attachments fit. */
  readonly room: number
  /** Opens the camera (`earth_capture`) or the library (`uploaded`). */
  pick(source: MediaSource): Promise<void>
  remove(key: string): void
  clear(): void
}

let counter = 0
function nextKey(): string {
  counter += 1
  return `media-${counter}`
}

/** The bytes of a local `file://` URI for `media.upload`. */
export async function readFileBody(uri: string): Promise<ArrayBuffer> {
  const response = await fetch(uri)
  return response.arrayBuffer()
}

type PickOutcome =
  | { readonly status: 'picked'; readonly assets: readonly ImagePicker.ImagePickerAsset[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'denied' }

async function launch(source: MediaSource, limit: number): Promise<PickOutcome> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) return { status: 'denied' }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images', 'videos'],
      quality: PICKER_IMAGE_QUALITY,
    })
    return result.canceled ? { status: 'cancelled' } : { status: 'picked', assets: result.assets }
  }
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) return { status: 'denied' }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    quality: PICKER_IMAGE_QUALITY,
  })
  return result.canceled ? { status: 'cancelled' } : { status: 'picked', assets: result.assets }
}

export function useMediaUpload(): MediaUploads {
  const shell = useFeedShell()
  const { earth, toast } = shell
  const [state, dispatch] = useReducer(pendingMediaReducer, EMPTY_PENDING_MEDIA)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const upload = useCallback(
    async (key: string, picked: PickedMedia) => {
      try {
        const body = await readFileBody(picked.uri)
        const media = await earth.media.upload(body, {
          bucket: STORAGE_BUCKETS.media,
          contentType: picked.contentType,
          width: picked.width > 0 ? picked.width : null,
          height: picked.height > 0 ? picked.height : null,
          durationMs: picked.durationMs,
          byteSize: picked.byteSize ?? body.byteLength,
        })
        dispatch({
          type: 'uploaded',
          key,
          args: {
            mediaObjectId: media.id,
            storageKey: media.storageKey,
            mediaType: picked.mediaType,
            width: picked.width,
            height: picked.height,
            durationMs: picked.durationMs,
            provenance: picked.provenance,
          },
        })
      } catch {
        dispatch({ type: 'failed', key })
      }
    },
    [earth],
  )

  const pick = useCallback(
    async (source: MediaSource) => {
      const room = mediaRoom(stateRef.current)
      if (room === 0) return
      let outcome: PickOutcome
      try {
        outcome = await launch(source, room)
      } catch {
        toast(postCopy.somethingWrong)
        return
      }
      if (outcome.status === 'denied') {
        toast(source === 'camera' ? postCopy.cameraPermission : postCopy.photosPermission)
        return
      }
      if (outcome.status === 'cancelled') return
      let rejected = 0
      const items: PendingMedia[] = []
      for (const asset of outcome.assets) {
        const picked = pickedMediaFromAsset(asset, source)
        if (picked === null) {
          rejected += 1
          continue
        }
        items.push({ key: nextKey(), picked, status: 'uploading', args: null })
      }
      const taking = items.slice(0, room)
      dispatch({ type: 'add', items, rejected })
      for (const item of taking) void upload(item.key, item.picked)
    },
    [toast, upload],
  )

  const remove = useCallback((key: string) => dispatch({ type: 'remove', key }), [])
  const clear = useCallback(() => dispatch({ type: 'clear' }), [])

  return {
    state,
    uploading: isUploading(state),
    ready: [...readyMedia(state)],
    room: mediaRoom(state),
    pick,
    remove,
    clear,
  }
}
