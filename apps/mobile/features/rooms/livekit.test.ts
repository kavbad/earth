import { describe, expect, it, vi } from 'vitest'

// The SDK reaches into native modules at import time; the pure helpers are what is under test.
vi.mock('@livekit/react-native', () => ({
  AndroidAudioTypePresets: {
    communication: { manageAudioFocus: true, audioMode: 'inCommunication' },
    media: { manageAudioFocus: true, audioMode: 'normal' },
  },
  AudioSession: {
    configureAudio: vi.fn(() => Promise.resolve()),
    setAppleAudioConfiguration: vi.fn(() => Promise.resolve()),
    startAudioSession: vi.fn(() => Promise.reject(new Error('no native module'))),
    stopAudioSession: vi.fn(() => Promise.resolve()),
  },
  registerGlobals: vi.fn(),
}))

const livekit = await import('./livekit')
const sdk = await import('@livekit/react-native')

describe('ensureLiveKitGlobals (spec §57: registered once, before any room)', () => {
  it('registers on import when the shell has not, and never twice', () => {
    expect(sdk.registerGlobals).toHaveBeenCalledTimes(1)
    expect(livekit.ensureLiveKitGlobals()).toBe(false)
    expect(sdk.registerGlobals).toHaveBeenCalledTimes(1)
  })

  it('recognises the marker the SDK leaves on the global scope', () => {
    expect(livekit.hasLiveKitGlobals({})).toBe(false)
    expect(
      livekit.hasLiveKitGlobals({ [livekit.LIVEKIT_GLOBALS_MARKER]: { platform: 'ios' } }),
    ).toBe(true)
  })
})

describe('room audio configuration (background audio)', () => {
  it('prefers a headset, falls back to the speaker, and uses voice-communication focus', () => {
    const config = livekit.roomAudioConfiguration()
    expect(config.android?.preferredOutputList?.[0]).toBe('bluetooth')
    expect(config.android?.preferredOutputList).toContain('speaker')
    expect(config.android?.audioTypeOptions).toBe(sdk.AndroidAudioTypePresets.communication)
    expect(config.ios?.defaultOutput).toBe('speaker')
  })

  it('keeps iOS recording and playing with Bluetooth in a video chat', () => {
    const apple = livekit.roomAppleAudioConfiguration()
    expect(apple.audioCategory).toBe('playAndRecord')
    expect(apple.audioMode).toBe('videoChat')
    expect(apple.audioCategoryOptions).toEqual(
      expect.arrayContaining(['allowBluetooth', 'defaultToSpeaker']),
    )
  })

  it('applies both configurations and swallows a missing native module', async () => {
    await livekit.configureRoomAudio()
    expect(sdk.AudioSession.configureAudio).toHaveBeenCalledWith(livekit.roomAudioConfiguration())
    expect(sdk.AudioSession.setAppleAudioConfiguration).toHaveBeenCalledWith(
      livekit.roomAppleAudioConfiguration(),
    )
    await expect(livekit.startRoomAudio()).resolves.toBeUndefined()
    await expect(livekit.stopRoomAudio()).resolves.toBeUndefined()
  })
})
