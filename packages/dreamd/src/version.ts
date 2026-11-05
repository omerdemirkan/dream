import { Effect, FileSystem, Option, Schema } from "effect"

/** Reported by `Health`. Bump with changes the control plane may need to tell apart. */
export const version = "0.1.0"

/**
 * What the template build stamps into `/opt/dream/release.json`: a hash of everything it copied into `/opt/dream`
 * (dreamd, the CLI, the prompt and skill, the harness pins, the lockfile), so two builds of the same source share it.
 */
export const ReleaseFile = Schema.Struct({ release: Schema.String })

/** `release.json` at the root of the tree dreamd runs from (`/opt/dream` in a sandbox). */
export const releaseFile = new URL("../../../release.json", import.meta.url).pathname

/** This dreamd's release, if it runs from a template build (not from a checkout or in tests). */
export const readRelease = (file: string = releaseFile) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file).pipe(Effect.option)
    if (Option.isNone(text)) return Option.none<string>()
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseFile))(text.value).pipe(
      Effect.map((decoded) => Option.some(decoded.release)),
      Effect.catch((error) =>
        Effect.logWarning(`${file} isn't a release file`, { error: error.message }).pipe(
          Effect.as(Option.none<string>())
        )
      )
    )
  })
