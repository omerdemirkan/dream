/**
 * dreamd's state on disk: small JSON documents, decoded with a schema on the
 * way in and replaced atomically (write a temp file, fsync, rename) on the way
 * out, so a crash or a sandbox pause never leaves a half-written file.
 */
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect"

export class StateFileError extends Data.TaggedError("StateFileError")<{
  readonly path: string
  readonly cause: unknown
}> {
  override get message() {
    return `Couldn't use ${this.path}: ${String(this.cause)}`
  }
}

export const make = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, path: string) => {
  const codec = Schema.fromJsonString(Schema.toCodecJson(schema), { space: 2 })
  const decode = Schema.decodeUnknownEffect(codec)
  const encode = Schema.encodeEffect(codec)

  /** The stored value, or `None` if the file doesn't exist yet. */
  const read: Effect.Effect<Option.Option<S["Type"]>, StateFileError, FileSystem.FileSystem> = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path))) return Option.none()
    const text = yield* fs.readFileString(path)
    return Option.some(yield* decode(text))
  }).pipe(Effect.mapError((cause) => new StateFileError({ path, cause })))

  const write = (value: S["Type"]): Effect.Effect<void, StateFileError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const text = yield* encode(value)
      const temporary = `${path}.${process.pid}.tmp`
      yield* fs.makeDirectory(paths.dirname(path), { recursive: true })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporary, { flag: "w", mode: 0o600 })
          yield* file.writeAll(new TextEncoder().encode(text))
          yield* file.sync
        })
      )
      yield* fs.rename(temporary, path)
    }).pipe(Effect.mapError((cause) => new StateFileError({ path, cause })))

  return { path, read, write } as const
}
