/**
 * Small secrets kept on the device: the session token and the install's device
 * id. Backed by the iOS keychain (expo-secure-store) in the app, and by memory
 * in tests and fixtures mode.
 */
import { Context, Data, Effect, Layer, Option } from "effect"

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly key: string
  readonly cause: unknown
}> {}

export class SecureStorage extends Context.Service<
  SecureStorage,
  {
    readonly get: (key: string) => Effect.Effect<Option.Option<string>, StorageError>
    readonly set: (key: string, value: string) => Effect.Effect<void, StorageError>
    readonly remove: (key: string) => Effect.Effect<void, StorageError>
  }
>()("@dream/mobile/SecureStorage") {
  static readonly layerMemory = (initial: Iterable<readonly [string, string]> = []) =>
    Layer.sync(SecureStorage, () => {
      const values = new Map(initial)
      return {
        get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
        set: (key, value) => Effect.sync(() => void values.set(key, value)),
        remove: (key) => Effect.sync(() => void values.delete(key))
      }
    })
}
