/**
 * What the runtime version (expo-updates' fingerprint policy) is computed from: the native project, everything
 * that generates it, and the update signing certificate. An over-the-air update reaches only builds with its
 * runtime version, so a JavaScript update can't land on a build missing native code it needs.
 *
 * Left out, because they don't change native code: version and build number (every TestFlight upload has a new
 * one) and `extra` (the JavaScript reads it from the update itself).
 */
const { existsSync, readFileSync } = require("node:fs")
const { resolve } = require("node:path")

const certificate = resolve(__dirname, process.env.DREAM_UPDATES_CERTIFICATE ?? "certs/updates-certificate.pem")

/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  sourceSkips: ["ExpoConfigVersions", "ExpoConfigExtraSection"],
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
