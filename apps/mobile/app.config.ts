import type { ConfigContext, ExpoConfig } from 'expo/config'

/** Canonical web origin; deep links under it open in the app (ARCHITECTURE.md §14). */
const WEB_HOST = 'earth.social'
const BUNDLE_ID = 'social.earth.app'
const DEEP_LINK_PATH_PREFIXES = ['/g/', '/live/', '/p/', '/@'] as const
/** Placeholder; replace with the real EAS project id before the first EAS build. */
const EAS_PROJECT_ID = '00000000-0000-0000-0000-000000000000'

const config = ({ config: base }: ConfigContext): ExpoConfig => ({
  ...base,
  name: 'Earth',
  slug: 'earth',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'earth',
  userInterfaceStyle: 'light',
  icon: './assets/icon.png',
  backgroundColor: '#ffffff',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    associatedDomains: [`applinks:${WEB_HOST}`],
    infoPlist: {
      UIBackgroundModes: ['audio', 'voip'],
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: BUNDLE_ID,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: DEEP_LINK_PATH_PREFIXES.map((pathPrefix) => ({
          scheme: 'https',
          host: WEB_HOST,
          pathPrefix,
        })),
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-splash-screen',
      {
        image: './assets/splash.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#ffffff',
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission: 'Earth uses the camera so you can go Live and post photos.',
        microphonePermission: 'Earth uses the microphone so people can hear you in rooms.',
        recordAudioAndroid: true,
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Earth uses your location to show what is happening around you and to share it with people you choose.',
      },
    ],
    [
      'expo-notifications',
      {
        // Android: a push lands on `messages` unless the server names `live` or `social`;
        // the app creates all three channels before it registers a token (lib/push.ts).
        defaultChannel: 'messages',
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Earth uses your photos so you can post and set your picture.',
        cameraPermission: 'Earth uses the camera so you can take a photo to post.',
      },
    ],
    '@livekit/react-native-expo-plugin',
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 24,
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: false,
  },
  extra: {
    eas: {
      projectId: EAS_PROJECT_ID,
    },
  },
})

export default config
