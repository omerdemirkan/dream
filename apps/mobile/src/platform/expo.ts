/**
 * The platform pieces the data layer needs, from Expo and React Native.
 */
import { fetch as expoFetch } from "expo/fetch"
import * as SecureStore from "expo-secure-store"
import { Effect, Layer, Option } from "effect"
import { Socket } from "effect/socket"
import type { Platform } from "../data/AppLayer.ts"
import { SecureStorage, StorageError } from "../data/SecureStorage.ts"
import { fileTransfer } from "./attachments.ts"

// Readable after the first unlock, so work done in the background (a silent
// push, a Live Activity token) can still reach the session.
const keychain: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }

const storage = Layer.succeed(SecureStorage, {
  get: (key) =>
    Effect.tryPromise({
      try: () => SecureStore.getItemAsync(key, keychain),
      catch: (cause) => new StorageError({ key, cause })
    }).pipe(Effect.map(Option.fromNullishOr)),
  set: (key, value) =>
    Effect.tryPromise({
      try: () => SecureStore.setItemAsync(key, value, keychain),
      catch: (cause) => new StorageError({ key, cause })
    }),
  remove: (key) =>
    Effect.tryPromise({
      try: () => SecureStore.deleteItemAsync(key, keychain),
      catch: (cause) => new StorageError({ key, cause })
    })
})

/**
 * React Native's built-in fetch can't stream response bodies, and the RPC
 * client reads NDJSON as a stream; `expo/fetch` can. Its request and response
 * types are WinterCG-shaped rather than the DOM's, hence the one cast here.
 */
const streamingFetch = ((input, init) => expoFetch(input as string, init as never)) as typeof globalThis.fetch

export const expoPlatform: Platform = {
  storage,
  webSocket: Socket.layerWebSocketConstructorGlobal,
  fetch: streamingFetch,
  fileTransfer
}
