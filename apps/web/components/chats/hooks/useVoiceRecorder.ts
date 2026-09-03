'use client'

/**
 * Voice messages (SCREEN 10 composer microphone): `MediaRecorder` over the microphone, stopped
 * into one Blob with its duration. The caller uploads it to the `voice` bucket and sends an
 * `audio` message. No audio is kept once the recording is handed over or cancelled.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

export const VOICE_MAX_MS = 5 * 60_000
/** Preferred containers in order; the first the browser supports wins. */
export const VOICE_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const

export type VoiceRecorderStatus = 'idle' | 'requesting' | 'recording' | 'unavailable'

export interface VoiceRecording {
  readonly blob: Blob
  readonly contentType: string
  readonly durationMs: number
}

export interface VoiceRecorder {
  readonly status: VoiceRecorderStatus
  /** Milliseconds recorded so far (updates twice a second while recording). */
  readonly elapsedMs: number
  readonly supported: boolean
  start(): Promise<void>
  /** Stops and resolves the recording; `null` when nothing usable was captured. */
  stop(): Promise<VoiceRecording | null>
  cancel(): void
}

interface MediaRecorderCtor {
  new (stream: MediaStream, options?: { mimeType?: string }): MediaRecorder
  isTypeSupported?(type: string): boolean
}

function recorderCtor(): MediaRecorderCtor | null {
  if (typeof window === 'undefined') return null
  const ctor = (window as unknown as { MediaRecorder?: MediaRecorderCtor }).MediaRecorder
  return ctor === undefined ? null : ctor
}

const subscribeNever = (): (() => void) => () => undefined

function detectSupport(): boolean {
  return (
    recorderCtor() !== null &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  )
}

export function pickVoiceMimeType(isSupported: (type: string) => boolean): string | null {
  for (const candidate of VOICE_MIME_CANDIDATES) {
    if (isSupported(candidate)) return candidate
  }
  return null
}

/** `audio/webm;codecs=opus` → `audio/webm` (the storage content type carries no parameters). */
export function baseContentType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? mimeType
}

export function useVoiceRecorder(): VoiceRecorder {
  const [status, setStatus] = useState<VoiceRecorderStatus>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef<number>(0)
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null)
  // Server snapshot: unsupported, so the microphone control hydrates disabled and then enables.
  const supported = useSyncExternalStore(subscribeNever, detectSupport, () => false)

  const release = useCallback(() => {
    if (ticker.current !== null) clearInterval(ticker.current)
    ticker.current = null
    for (const track of stream.current?.getTracks() ?? []) track.stop()
    stream.current = null
    recorder.current = null
    chunks.current = []
  }, [])

  useEffect(() => release, [release])

  const stop = useCallback((): Promise<VoiceRecording | null> => {
    const current = recorder.current
    if (current === null || current.state === 'inactive') {
      release()
      setStatus('idle')
      setElapsedMs(0)
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      const durationMs = Math.min(VOICE_MAX_MS, Date.now() - startedAt.current)
      current.addEventListener(
        'stop',
        () => {
          const mimeType = current.mimeType || chunks.current[0]?.type || 'audio/webm'
          const blob = new Blob(chunks.current, { type: mimeType })
          release()
          setStatus('idle')
          setElapsedMs(0)
          resolve(
            blob.size > 0 && durationMs > 300
              ? { blob, contentType: baseContentType(mimeType), durationMs }
              : null,
          )
        },
        { once: true },
      )
      current.stop()
    })
  }, [release])

  const start = useCallback(async () => {
    const Ctor = recorderCtor()
    if (Ctor === null || !supported) {
      setStatus('unavailable')
      return
    }
    setStatus('requesting')
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.current = media
      const mimeType = pickVoiceMimeType((type) => Ctor.isTypeSupported?.(type) ?? false)
      const instance = mimeType === null ? new Ctor(media) : new Ctor(media, { mimeType })
      chunks.current = []
      instance.addEventListener('dataavailable', (event: BlobEvent) => {
        if (event.data.size > 0) chunks.current.push(event.data)
      })
      recorder.current = instance
      startedAt.current = Date.now()
      instance.start(500)
      setElapsedMs(0)
      setStatus('recording')
      ticker.current = setInterval(() => {
        const elapsed = Date.now() - startedAt.current
        setElapsedMs(elapsed)
        if (elapsed >= VOICE_MAX_MS) void stop()
      }, 500)
    } catch {
      release()
      setStatus('unavailable')
    }
  }, [release, stop, supported])

  const cancel = useCallback(() => {
    const current = recorder.current
    if (current !== null && current.state !== 'inactive') {
      try {
        current.stop()
      } catch {
        // Already stopping.
      }
    }
    release()
    setStatus('idle')
    setElapsedMs(0)
  }, [release])

  return { status, elapsedMs, supported, start, stop, cancel }
}
