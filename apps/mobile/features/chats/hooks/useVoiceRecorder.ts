/**
 * Voice messages (SCREEN 10 composer microphone): `expo-av` recording with the background audio
 * mode the app declares (`UIBackgroundModes: audio`), stopped into one local file with its
 * duration. The caller uploads it to the `voice` bucket and sends an `audio` message. Nothing is
 * kept once the recording is handed over or cancelled.
 */
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av'
import { useCallback, useEffect, useRef, useState } from 'react'

export const VOICE_MAX_MS = 5 * 60_000
/** The HIGH_QUALITY preset writes AAC in an `.m4a` container on both platforms. */
export const VOICE_CONTENT_TYPE = 'audio/mp4' as const
/** Recordings shorter than this are a slip of the thumb, not a message. */
export const VOICE_MIN_MS = 300

export type VoiceRecorderStatus = 'idle' | 'requesting' | 'recording' | 'unavailable'

export interface VoiceRecording {
  readonly uri: string
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
  /** Back to `idle` after `unavailable` was shown. */
  reset(): void
}

export async function setRecordingAudioMode(recording: boolean): Promise<void> {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: recording,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  })
}

export function useVoiceRecorder(): VoiceRecorder {
  const [status, setStatus] = useState<VoiceRecorderStatus>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const recorder = useRef<Audio.Recording | null>(null)
  const startedAt = useRef(0)
  const lastDuration = useRef(0)
  const stopping = useRef(false)

  const release = useCallback(async (): Promise<string | null> => {
    const current = recorder.current
    recorder.current = null
    if (current === null) return null
    try {
      await current.stopAndUnloadAsync()
    } catch {
      // Already stopped, or nothing was recorded.
    }
    try {
      await setRecordingAudioMode(false)
    } catch {
      // Playback mode is restored on the next player start.
    }
    return current.getURI()
  }, [])

  useEffect(
    () => () => {
      void release()
    },
    [release],
  )

  const stop = useCallback(async (): Promise<VoiceRecording | null> => {
    if (recorder.current === null || stopping.current) {
      setStatus('idle')
      setElapsedMs(0)
      return null
    }
    stopping.current = true
    const durationMs = Math.min(
      VOICE_MAX_MS,
      Math.max(lastDuration.current, Date.now() - startedAt.current),
    )
    const uri = await release()
    stopping.current = false
    setStatus('idle')
    setElapsedMs(0)
    if (uri === null || durationMs < VOICE_MIN_MS) return null
    return { uri, contentType: VOICE_CONTENT_TYPE, durationMs: Math.round(durationMs) }
  }, [release])

  const start = useCallback(async () => {
    if (recorder.current !== null) return
    setStatus('requesting')
    try {
      const permission = await Audio.requestPermissionsAsync()
      if (!permission.granted) {
        setStatus('unavailable')
        return
      }
      await setRecordingAudioMode(true)
      const preset =
        Audio.RecordingOptionsPresets['HIGH_QUALITY'] ??
        Audio.RecordingOptionsPresets['LOW_QUALITY']
      const { recording } = await Audio.Recording.createAsync(
        preset,
        (update) => {
          if (!update.isRecording) return
          lastDuration.current = update.durationMillis
          setElapsedMs(update.durationMillis)
          if (update.durationMillis >= VOICE_MAX_MS) void stop()
        },
        500,
      )
      recorder.current = recording
      startedAt.current = Date.now()
      lastDuration.current = 0
      setElapsedMs(0)
      setStatus('recording')
    } catch {
      await release()
      setStatus('unavailable')
    }
  }, [release, stop])

  const cancel = useCallback(() => {
    void release()
    setStatus('idle')
    setElapsedMs(0)
  }, [release])

  const reset = useCallback(() => {
    setStatus('idle')
    setElapsedMs(0)
  }, [])

  return { status, elapsedMs, supported: true, start, stop, cancel, reset }
}
