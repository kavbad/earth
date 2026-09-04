/**
 * Playback of one voice message (`expo-av` Sound): play / pause, position and duration, unloaded
 * when the row leaves the screen. Plays through the speaker in silent mode, like a message should.
 */
import { Audio } from 'expo-av'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface AudioPlayer {
  readonly playing: boolean
  readonly loading: boolean
  readonly positionMs: number
  readonly durationMs: number | null
  readonly error: boolean
  toggle(): Promise<void>
}

export function useAudioPlayer(url: string | null): AudioPlayer {
  const sound = useRef<Audio.Sound | null>(null)
  const finished = useRef(false)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    finished.current = false
    return () => {
      const current = sound.current
      sound.current = null
      if (current !== null) void current.unloadAsync().catch(() => undefined)
    }
  }, [url])

  const toggle = useCallback(async () => {
    if (url === null) return
    try {
      const current = sound.current
      if (current === null) {
        setLoading(true)
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
        })
        const created = await Audio.Sound.createAsync(
          { uri: url },
          { shouldPlay: true },
          (status) => {
            if (!status.isLoaded) {
              if (status.error !== undefined) setError(true)
              return
            }
            setPlaying(status.isPlaying)
            setPositionMs(status.positionMillis)
            setDurationMs(status.durationMillis ?? null)
            if (status.didJustFinish) {
              finished.current = true
              setPlaying(false)
            }
          },
        )
        sound.current = created.sound
        setLoading(false)
        setError(false)
        return
      }
      if (playing) {
        await current.pauseAsync()
        return
      }
      if (finished.current) {
        finished.current = false
        await current.replayAsync()
        return
      }
      await current.playAsync()
    } catch {
      setLoading(false)
      setError(true)
    }
  }, [url, playing])

  return { playing, loading, positionMs, durationMs, error, toggle }
}
