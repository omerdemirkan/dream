import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { ConfigContext, ExpoConfig } from "expo/config"

/**
 * Build-time settings come from the environment (the build script, or a local
 * `.env`), so nothing account-specific is checked in:
 *
 * - DREAM_BUNDLE_ID             iOS bundle id (placeholder until the founder confirms)
 * - DREAM_APPLE_TEAM_ID         Apple team, needed to sign the app and its widget extension
 * - DREAM_API_URL               the API, e.g. https://dream.omer.build
 * - DREAM_BACKEND               "fixtures" (in-app fake backend) or "live"
 * - DREAM_GOOGLE_IOS_CLIENT_ID  iOS OAuth client for Google Sign-In
 * - DREAM_GOOGLE_WEB_CLIENT_ID  optional: makes Google's ID token audience the web client
 * - DREAM_APS_ENVIRONMENT       "development" or "production" (APNs entitlement)
 * - DREAM_UPDATES_CHANNEL       the over-the-air update channel the build follows: "production" for TestFlight
 *                               builds (APNs production), "fixtures" for the fixtures backend, else "development"
 * - DREAM_UPDATES_URL           the update server, default `<DREAM_API_URL>/updates/manifest`
 * - DREAM_UPDATES_CERTIFICATE   the code signing certificate updates must verify against, default
 *                               certs/updates-certificate.pem (written by `scripts/updates.ts init`). Without
 *                               one the build has no over-the-air updates.
 * - DREAM_UPDATES_ENABLED       "1" turns over-the-air updates on in a build that isn't for TestFlight (they're
 *                               always on with DREAM_APS_ENVIRONMENT=production, and off otherwise)
 */
const env = process.env
const bundleId = env.DREAM_BUNDLE_ID ?? "build.omer.dream"
const googleIosClientId = env.DREAM_GOOGLE_IOS_CLIENT_ID
const apiUrl = env.DREAM_API_URL ?? "https://dream.omer.build"

/**
 * Over-the-air updates (expo-updates against Dream's own Worker; see README "Over-the-air updates"). An update
 * reaches only builds whose runtime version, a fingerprint of the native project (fingerprint.config.js), is
 * its own, and only on the build's channel. Every update must be signed by the key the certificate belongs to.
 */
const backend = env.DREAM_BACKEND ?? "fixtures"
const updatesChannel =
  env.DREAM_UPDATES_CHANNEL ??
  (env.DREAM_APS_ENVIRONMENT === "production" ? "production" : backend === "fixtures" ? "fixtures" : "development")
const updatesCertificate = env.DREAM_UPDATES_CERTIFICATE ?? "./certs/updates-certificate.pem"
// Only TestFlight builds take updates unless a build asks for them: a Debug build loads its JavaScript from Metro,
// which doesn't sign it, and a Simulator build under test shouldn't have its JavaScript replaced by a published one.
const updatesWanted = env.DREAM_APS_ENVIRONMENT === "production" || env.DREAM_UPDATES_ENABLED === "1"
const updatesEnabled = updatesWanted && existsSync(resolve(__dirname, updatesCertificate))

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
  runtimeVersion: { policy: "fingerprint" },
  updates: updatesEnabled
    ? {
        enabled: true,
        url: env.DREAM_UPDATES_URL ?? `${apiUrl}/updates/manifest`,
        // Check on every launch without holding it up; what's downloaded runs from the next launch on
        // (src/ui/UpdatesHost.tsx also applies it when the app comes back after a long while).
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
        codeSigningCertificate: updatesCertificate,
        codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
        requestHeaders: { "expo-channel-name": updatesChannel }
      }
    : { enabled: false },
  ios: {
    bundleIdentifier: bundleId,
    ...(env.DREAM_APPLE_TEAM_ID ? { appleTeamId: env.DREAM_APPLE_TEAM_ID } : {}),
    supportsTablet: false,
    // CFBundleVersion: build-ios.sh sets BUILD_NUMBER so the app and its widget carry the same, new build number.
    ...(env.BUILD_NUMBER ? { buildNumber: env.BUILD_NUMBER } : {}),
    infoPlist: {
      // expo-image and expo-file-system link photo-library APIs, so App Store Connect requires a purpose string
      // even though Dream never opens the photo library.
      NSPhotoLibraryUsageDescription: "Dream doesn't use your photo library.",
      NSSupportsLiveActivities: true,
      NSSupportsLiveActivitiesFrequentUpdates: true,
      ITSAppUsesNonExemptEncryption: false
    }
  },
  plugins: [
    "expo-router",
    "expo-updates",
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
        speechRecognitionPermission:
          "Dream turns what you say into text in the field. Nothing is sent until you tap send."
      }
    ],
    ...(googleIosClientId
      ? [
          ["@react-native-google-signin/google-signin", { iosUrlScheme: reversedClientId(googleIosClientId) }] as [
            string,
            unknown
          ]
        ]
      : []),
    "@bacons/apple-targets"
  ],
  experiments: {
    typedRoutes: false,
    reactCompiler: true
  },
  extra: {
    apiUrl,
    backend,
    ...(googleIosClientId ? { googleIosClientId } : {}),
    ...(env.DREAM_GOOGLE_WEB_CLIENT_ID ? { googleWebClientId: env.DREAM_GOOGLE_WEB_CLIENT_ID } : {})
  }
})
