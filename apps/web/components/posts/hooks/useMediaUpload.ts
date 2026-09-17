'use client'

/**
 * Composer attachments (SCREEN 06): each chosen photo or video uploads at once through
 * `media.upload` into the `media` bucket and becomes a `PostMediaArgs` for `post_create`. The
 * row shows a preview from an object URL while it uploads; a failed upload can be removed.
 */
import { type PostMediaArgs, STORAGE_BUCKETS } from '@earth/api'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useEarth } from '../../../lib/providers/RuntimeProvider'
import { measureImage, measureVideo } from '../media/dimensions'
import { POST_MEDIA_MAX, postMediaType } from '../state/media'

export type PendingMediaStatus = 'uploading' | 'ready' | 'failed'

export interface PendingMedia {
  readonly key: string
  readonly previewUrl: string
  readonly mediaType: 'image' | 'video'
  readonly status: PendingMediaStatus
  readonly args: PostMediaArgs | null
}

export interface MediaUploads {
  readonly items: readonly PendingMedia[]
  readonly uploading: boolean
  readonly ready: readonly PostMediaArgs[]
  /** Files refused because there were too many or they were not photos/videos. */
  readonly rejected: number
  add(files: readonly File[]): void
  remove(key: string): void
  clear(): void
}

let counter = 0
function nextKey(): string {
  counter += 1
  return `media-${counter}`
}

export function useMediaUpload(): MediaUploads {
  const earth = useEarth()
  const [items, setItems] = useState<readonly PendingMedia[]>([])
  const [rejected, setRejected] = useState(0)
  const urls = useRef<Set<string>>(new Set())

  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url)
      urls.current.clear()
    },
    [],
  )

  const update = useCallback((key: string, patch: Partial<PendingMedia>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }, [])

  const upload = useCallback(
    async (key: string, file: File, mediaType: 'image' | 'video') => {
      try {
        const size = mediaType === 'image' ? await measureImage(file) : await measureVideo(file)
        const media = await earth.media.upload(file, {
          bucket: STORAGE_BUCKETS.media,
          contentType: file.type.toLowerCase(),
          width: size?.width ?? null,
          height: size?.height ?? null,
          durationMs: size?.durationMs ?? null,
          byteSize: file.size,
        })
        update(key, {
          status: 'ready',
          args: {
            mediaObjectId: media.id,
            storageKey: media.storageKey,
            mediaType,
            width: size?.width ?? 0,
            height: size?.height ?? 0,
            durationMs: size?.durationMs ?? null,
            provenance: 'uploaded',
          },
        })
      } catch {
        update(key, { status: 'failed' })
      }
    },
    [earth, update],
  )

  const add = useCallback(
    (files: readonly File[]) => {
      let refused = 0
      const accepted: Array<{ file: File; mediaType: 'image' | 'video' }> = []
      for (const file of files) {
        const mediaType = postMediaType(file.type)
        if (mediaType === null) {
          refused += 1
          continue
        }
        accepted.push({ file, mediaType })
      }
      setItems((current) => {
        const room = Math.max(0, POST_MEDIA_MAX - current.length)
        const taking = accepted.slice(0, room)
        refused += accepted.length - taking.length
        const added = taking.map(({ file, mediaType }) => {
          const key = nextKey()
          const previewUrl = URL.createObjectURL(file)
          urls.current.add(previewUrl)
          void upload(key, file, mediaType)
          return { key, previewUrl, mediaType, status: 'uploading' as const, args: null }
        })
        return [...current, ...added]
      })
      if (refused > 0) setRejected((count) => count + refused)
    },
    [upload],
  )

  const remove = useCallback((key: string) => {
    setItems((current) => {
      const item = current.find((entry) => entry.key === key)
      if (item !== undefined) {
        URL.revokeObjectURL(item.previewUrl)
        urls.current.delete(item.previewUrl)
      }
      return current.filter((entry) => entry.key !== key)
    })
  }, [])

  const clear = useCallback(() => {
    setItems((current) => {
      for (const item of current) {
        URL.revokeObjectURL(item.previewUrl)
        urls.current.delete(item.previewUrl)
      }
      return []
    })
    setRejected(0)
  }, [])

  return {
    items,
    uploading: items.some((item) => item.status === 'uploading'),
    ready: items.flatMap((item) => (item.args === null ? [] : [item.args])),
    rejected,
    add,
    remove,
    clear,
  }
}
