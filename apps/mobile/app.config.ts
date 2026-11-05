import type { ConfigContext, ExpoConfig } from "expo/config"

/**
 * Build-time settings come from the environment (EAS env vars, or a local
 * `.env`), so nothing account-specific is checked in:
 *
 * - DREAM_BUNDLE_ID             iOS bundle id (placeholder until the founder confirms)
 * - DREAM_APPLE_TEAM_ID         Apple team, needed to sign the app and its widget extension
 * - DREAM_EAS_PROJECT_ID        EAS project id, set once `eas init` has linked the project
 * - DREAM_API_URL               the API, e.g. https://dream.omer.build
 * - DREAM_BACKEND               "fixtures" (in-app fake backend) or "live"
 * - DREAM_GOOGLE_IOS_CLIENT_ID  iOS OAuth client for Google Sign-In
 * - DREAM_APS_ENVIRONMENT       "development" or "production" (APNs entitlement)
 */
const env = process.env
const bundleId = env.DREAM_BUNDLE_ID ?? "com.omer.dream"
const googleIosClientId = env.DREAM_GOOGLE_IOS_CLIENT_ID
const easProjectId = env.DREAM_EAS_PROJECT_ID

/** Google Sign-In returns to the reversed client id as a URL scheme. */
const reversedClientId = (clientId: string) => clientId.split(".").reverse().join(".")

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Dream",
  slug: "dream",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "dream",
  userInterfaceStyle: "dark",
  backgroundColor: "#0A0A0C",
  ios: {
    bundleIdentifier: bundleId,
    ...(env.DREAM_APPLE_TEAM_ID ? { appleTeamId: env.DREAM_APPLE_TEAM_ID } : {}),
    supportsTablet: false,
    infoPlist: {
      NSSupportsLiveActivities: true,
      NSSupportsLiveActivitiesFrequentUpdates: true,
      ITSAppUsesNonExemptEncryption: false
    }
  },
  plugins: [
    "expo-router",
    ["expo-splash-screen", { backgroundColor: "#0A0A0C", image: "./assets/images/splash-icon.png", imageWidth: 76 }],
    [
      "expo-notifications",
      {
        mode: env.DREAM_APS_ENVIRONMENT === "production" ? "production" : "development",
        enableBackgroundRemoteNotifications: true
      }
    ],
    "expo-secure-store",
    "expo-video",
    "expo-localization",
    "expo-web-browser",
    [
      "expo-speech-recognition",
      {
        microphonePermission: "Dream uses the microphone so you can dictate instead of typing.",
        speechRecognitionPermission: "Dream turns what you say into text in the field. Nothing is sent until you tap send."
      }
    ],
    ...(googleIosClientId
      ? [
          [
            "@react-native-google-signin/google-signin",
            { iosUrlScheme: reversedClientId(googleIosClientId) }
          ] as [string, unknown]
        ]
      : []),
    "@bacons/apple-targets"
  ],
  experiments: {
    typedRoutes: false,
    reactCompiler: true
  },
  extra: {
    apiUrl: env.DREAM_API_URL ?? "https://dream.omer.build",
    backend: env.DREAM_BACKEND ?? "fixtures",
    ...(googleIosClientId ? { googleIosClientId } : {}),
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {})
  }
})
