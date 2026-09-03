'use client'

import { useEffect, useRef, useState } from 'react'

import { roomCopy } from './copy'

export interface CameraPreviewProps {
  readonly on: boolean
  /** The camera could not be opened; the caller drops the preview and joins with audio. */
  readonly onUnavailable: () => void
}

/** SCREEN 17: an optional mirror of the front camera before entering — no track is published. */
export function CameraPreview({ on, onUnavailable }: CameraPreviewProps) {
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const unavailable = useRef(onUnavailable)
  useEffect(() => {
    unavailable.current = onUnavailable
  })

  useEffect(() => {
    if (!on) return
    const element = video.current
    let stream: MediaStream | null = null
    let cancelled = false
    const open = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        if (element !== null) element.srcObject = stream
      } catch {
        if (cancelled) return
        setFailed(true)
        unavailable.current()
      }
    }
    void open()
    return () => {
      cancelled = true
      stream?.getTracks().forEach((track) => track.stop())
      if (element !== null) element.srcObject = null
    }
  }, [on])

  if (!on) return null
  if (failed) {
    return (
      <p role="status" className="text-secondary text-text-secondary">
        {roomCopy.cameraUnavailable}
      </p>
    )
  }
  return (
    <video
      ref={video}
      autoPlay
      muted
      playsInline
      aria-label={roomCopy.cameraPreview}
      className="aspect-[3/4] w-full -scale-x-100 rounded-medium bg-subtle-fill object-cover"
    />
  )
}
