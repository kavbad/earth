/**
 * LiveKit on the device (spec §9, §57, §109; ARCHITECTURE §8): the WebRTC globals are registered
 * once before any room connects, and the native audio session is configured for a conversation —
 * speaker by default, voice-communication focus on Android, `playAndRecord` / `videoChat` with
 * Bluetooth on iOS — so audio keeps flowing when the app goes to the background
 * (`UIBackgroundModes: audio` in app.config.ts).
 *
 * Import this module at the top of every room screen module (`app/rooms/[id].tsx`,
 * `components/rooms/RoomScreen.tsx`); the import itself registers the globals. The app shell may
 * have registered them already at start-up — `registerGlobals` leaves a marker on the global
 * scope, and a second registration would double the native event bridges, so this module checks
 * the marker first. `useMediaConnection` calls the audio helpers around a connection.
 */
import {
  AndroidAudioTypePresets,
  type AppleAudioConfiguration,
  type AudioConfiguration,
  AudioSession,
  registerGlobals,
} from '@livekit/react-native'

/** Set on the global scope by `registerGlobals` (`LiveKitReactNativeInfo`). */
export const LIVEKIT_GLOBALS_MARKER = 'LiveKitReactNativeGlobal' as const

/** Whether `registerGlobals` already ran in this JavaScript context. */
export function hasLiveKitGlobals(scope: object): boolean {
  return (scope as Record<string, unknown>)[LIVEKIT_GLOBALS_MARKER] !== undefined
}

let registeredHere = false

/**
 * Registers the WebRTC globals unless the app shell (or an earlier import) did; returns whether
 * this call registered them.
 */
export function ensureLiveKitGlobals(scope: object = globalThis): boolean {
  if (registeredHere || hasLiveKitGlobals(scope)) return false
  registeredHere = true
  registerGlobals()
  return true
}

/**
 * The audio session of a room: the phone's speaker unless a headset or Bluetooth output is
 * present, Android in voice-communication mode with audio focus, iOS recording and playing with
 * Bluetooth allowed (the category the background `audio` mode keeps alive).
 */
export function roomAudioConfiguration(): AudioConfiguration {
  return {
    android: {
      preferredOutputList: ['bluetooth', 'headset', 'speaker', 'earpiece'],
      audioTypeOptions: AndroidAudioTypePresets.communication,
    },
    ios: { defaultOutput: 'speaker' },
  }
}

export function roomAppleAudioConfiguration(): AppleAudioConfiguration {
  return {
    audioCategory: 'playAndRecord',
    audioCategoryOptions: ['allowBluetooth', 'allowBluetoothA2DP', 'defaultToSpeaker'],
    audioMode: 'videoChat',
  }
}

/** Applies the room audio configuration; must run before the SDK room connects. */
export async function configureRoomAudio(): Promise<void> {
  try {
    await AudioSession.configureAudio(roomAudioConfiguration())
    await AudioSession.setAppleAudioConfiguration(roomAppleAudioConfiguration())
  } catch {
    // A missing native module (a web preview, a test) must not stop the connection.
  }
}

export async function startRoomAudio(): Promise<void> {
  try {
    await AudioSession.startAudioSession()
  } catch {
    // Same as above: the SDK's own errors decide once it connects.
  }
}

export async function stopRoomAudio(): Promise<void> {
  try {
    await AudioSession.stopAudioSession()
  } catch {
    // Nothing to stop.
  }
}

ensureLiveKitGlobals()
