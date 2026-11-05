/**
 * What the runtime version (expo-updates' fingerprint policy) is computed from: the native project, everything
 * that generates it, and the update signing certificate. An over-the-air update reaches only builds with its
 * runtime version, so a JavaScript update can't land on a build missing native code it needs.
 *
 * Left out, because they don't change native code: version and build number (every TestFlight upload has a new
 * one), `extra` (the JavaScript reads it from the update itself) and package.json scripts.
 */
const { existsSync, readFileSync } = require("node:fs")
const { resolve } = require("node:path")

const certificate = resolve(__dirname, process.env.DREAM_UPDATES_CERTIFICATE ?? "certs/updates-certificate.pem")

/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  // Expo's default ("balanced") skips, plus `extra`, and all package.json scripts: `expo prebuild` rewrites the
  // "ios" script on the build Mac, which would otherwise give the build another runtime version than publishing.
  sourceSkips: [
    "ExpoConfigVersions",
    "ExpoConfigRuntimeVersionIfString",
    "EasJson",
    "Easignore",
    "AutolinkingConfigPaths",
    "ExpoConfigExtraSection",
    "PackageJsonScriptsAll"
  ],
  extraSources: existsSync(certificate)
    ? [
        {
          type: "contents",
          id: "updatesCertificate",
          contents: readFileSync(certificate, "utf8"),
          reasons: ["expo-updates code signing certificate"]
        }
      ]
    : []
}
