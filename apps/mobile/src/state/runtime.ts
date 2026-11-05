/**
 * The atom runtime: every service the screens use, built once for the app
 * against the backend this build is configured for.
 */
import Constants from "expo-constants"
import { Atom } from "effect/reactivity"
import { decodeAppConfig } from "../data/AppConfig.ts"
import { makeAppLayer } from "../data/AppLayer.ts"
import { expoPlatform } from "../platform/expo.ts"

export const appConfig = decodeAppConfig(Constants.expoConfig?.extra)

export const appLayer = makeAppLayer(appConfig, expoPlatform)

export const appRuntime = Atom.runtime(appLayer)
