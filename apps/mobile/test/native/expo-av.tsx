/** The `expo-av` test double: a host `Video` element plus an inert `Audio` recorder / player. */
import { type ComponentType, type ReactNode } from 'react'

type AnyProps = Record<string, unknown> & { children?: ReactNode }

export const Video = 'Video' as unknown as ComponentType<AnyProps>

export const ResizeMode = { CONTAIN: 'contain', COVER: 'cover', STRETCH: 'stretch' } as const
export const InterruptionModeIOS = { DoNotMix: 0, DoNotMixWithOthers: 1, MixWithOthers: 2 } as const
export const InterruptionModeAndroid = { DoNotMix: 1, DuckOthers: 2 } as const

class Sound {
  static createAsync(): Promise<{ sound: Sound }> {
    return Promise.resolve({ sound: new Sound() })
  }
  playAsync(): Promise<void> {
    return Promise.resolve()
  }
  pauseAsync(): Promise<void> {
    return Promise.resolve()
  }
  unloadAsync(): Promise<void> {
    return Promise.resolve()
  }
  setOnPlaybackStatusUpdate(): void {
    return undefined
  }
}

class Recording {
  static createAsync(): Promise<{ recording: Recording }> {
    return Promise.resolve({ recording: new Recording() })
  }
  stopAndUnloadAsync(): Promise<void> {
    return Promise.resolve()
  }
  getURI(): string | null {
    return null
  }
  setOnRecordingStatusUpdate(): void {
    return undefined
  }
}

export const Audio = {
  Sound,
  Recording,
  setAudioModeAsync: (): Promise<void> => Promise.resolve(),
  requestPermissionsAsync: (): Promise<{ granted: boolean }> => Promise.resolve({ granted: true }),
  RecordingOptionsPresets: {} as Record<string, object>,
}
