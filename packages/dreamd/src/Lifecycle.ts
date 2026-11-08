/**
 * dreamd's own life, in the project's log (`dream` entries): each start (with the release it runs, and whether a
 * refresh or a crash came before it), each stop and why, and each time the sandbox slept and woke. A sleeping
 * sandbox runs nothing, so a sleep shows up afterwards, as the wall clock having moved on much further between two
 * looks than the time between them; it's logged when dreamd notices, within seconds of waking.
 */
import { DateTime, Duration, Effect, FileSystem, Option, Path, Ref, Schema, Stream } from "effect"
import { DreamdConfig } from "./Config.ts"
import * as JsonFile from "./JsonFile.ts"
import { ProjectLog } from "./Log.ts"
import { readRelease, version } from "./version.ts"

/** How often dreamd looks at the clocks. */
export const ClockEvery = Duration.seconds(10)
/** The wall clock moving this much further than `ClockEvery` between two looks means the sandbox slept. */
export const SleptAtLeast = Duration.seconds(30)

export const LifeState = Schema.Struct({
  release: Schema.optionalKey(Schema.String),
  /** Set at start, cleared at a clean stop: set at the next start means the last one didn't stop cleanly. */
  running: Schema.Boolean,
  /** When dreamd last looked at the clocks, while it ran. */
  seenAt: Schema.DateTimeUtc
})
export type LifeState = typeof LifeState.Type

/** The start, as the log says it. */
export const startLine = (release: string | undefined, previous: LifeState | undefined): string => {
  const runs = `dreamd ${version} started${release === undefined ? "" : `, from release ${release}`}`
  if (previous === undefined) return runs
  const refreshed =
    previous.release !== undefined && release !== undefined && previous.release !== release
      ? `; Dream refreshed it from release ${previous.release}`
      : ""
  const crashed = previous.running
    ? `; the last dreamd stopped without shutting down (it was last seen at ${DateTime.formatIso(previous.seenAt)})`
    : ""
  return `${runs}${refreshed}${crashed}`
}

/** "12 min", "3 h 5 min". */
export const span = (ms: number): string => {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h${minutes % 60 === 0 ? "" : ` ${minutes % 60} min`}`
}

export const make = Effect.gen(function* () {
  const config = yield* DreamdConfig
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const log = yield* ProjectLog
  const file = JsonFile.make(LifeState, path.join(config.stateDir, "life.json"))
  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))
  const release = Option.getOrUndefined(yield* readRelease())
  const save = (state: LifeState) => provide(file.write(state)).pipe(Effect.ignore)
  const with_ = (running: boolean, seenAt: DateTime.Utc): LifeState => ({
    ...(release === undefined ? {} : { release }),
    running,
    seenAt
  })

  /** Note the start, against what the last dreamd left. */
  const started = Effect.gen(function* () {
    const previous = Option.getOrUndefined(yield* provide(file.read).pipe(Effect.orElseSucceed(() => Option.none())))
    const now = yield* DateTime.now
    yield* log.note("dream", previous?.running === true ? "warn" : "info", startLine(release, previous))
    yield* save(with_(true, now))
  })

  /** Note a clean stop. */
  const stopping = (reason: string) =>
    Effect.gen(function* () {
      yield* log.note("dream", "info", `dreamd is stopping: ${reason}`)
      yield* save(with_(false, yield* DateTime.now))
    })

  /** Watch the clocks for sleeps, forever. */
  const watch = Effect.gen(function* () {
    const last = yield* Ref.make({ wall: Date.now(), savedAt: Date.now() })
    yield* Stream.tick(ClockEvery).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const wall = Date.now()
          const before = yield* Ref.get(last)
          const slept = wall - before.wall - Duration.toMillis(ClockEvery)
          const saveNow = slept >= Duration.toMillis(SleptAtLeast) || wall - before.savedAt >= 5 * 60_000
          yield* Ref.set(last, { wall, savedAt: saveNow ? wall : before.savedAt })
          if (slept >= Duration.toMillis(SleptAtLeast)) {
            // It went to sleep some time after the look before, and woke a moment before this one.
            const from = DateTime.makeUnsafe(before.wall)
            const to = DateTime.makeUnsafe(wall)
            yield* log.note(
              "dream",
              "info",
              `The sandbox slept for about ${span(slept)}, between ${DateTime.formatIso(from)} and ${DateTime.formatIso(to)}`
            )
          }
          if (saveNow) yield* save(with_(true, DateTime.makeUnsafe(wall)))
        })
      )
    )
    return yield* Effect.never
  })

  return { started, stopping, watch } as const
})
