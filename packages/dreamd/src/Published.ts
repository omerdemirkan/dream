/**
 * The project's published port, and a look at it after each turn. dreamd
 * notes the port when `dream publish` goes through the CLI socket. When a
 * turn completes, it asks the API for the public URL again and loads it the
 * way `dream publish` does. If it looks broken (an error status, uncaught page
 * errors, or no answer), the agent gets a `PublishedUrlBroken` event, which
 * starts a turn. That event is sent only when the finding differs from the
 * last one sent, so a breakage the agent can't fix doesn't wake it over and
 * over; a healthy load clears it. The person never hears about this.
 *
 * The load reaches the app through the public URL, so to the kernel it looks like someone using the app. `selfCheck`
 * says when one is running or just ran, so keeping the sandbox awake (`Awake`) can leave that traffic out.
 */
import { randomUUID } from "node:crypto"
import { AgentEvent, EventId } from "@dream/domain"
import { Clock, Context, DateTime, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect"
import { Api } from "./Api.ts"
import { pageCheck } from "./cli/Format.ts"
import { PageCheck, type PageLoad } from "./cli/PageCheck.ts"
import { DreamdConfig } from "./Config.ts"
import { Inbox } from "./Inbox.ts"
import * as JsonFile from "./JsonFile.ts"

export const PublishedState = Schema.Struct({
  port: Schema.Int,
  /** What the last `PublishedUrlBroken` was about (see `brokenKey`); absent once a load looked healthy. */
  reported: Schema.optionalKey(Schema.String)
})
export type PublishedState = typeof PublishedState.Type

/**
 * What makes a load look broken, as a key that stays the same while the breakage does; `undefined` when it looks
 * healthy. Failed subresources and console errors alone don't count: they're often harmless.
 */
export const brokenKey = (load: PageLoad): string | undefined => {
  if (load._tag === "Unreachable") return JSON.stringify(["unreachable", load.message])
  const errorStatus = load.status < 200 || load.status >= 300
  if (!errorStatus && load.pageErrors.length === 0) return undefined
  return JSON.stringify([
    load.status,
    errorStatus ? (load.firstLine ?? load.title ?? "") : "",
    [...load.pageErrors].sort()
  ])
}

/** dreamd's own load of the published URL: running now, and when the last one ended (epoch milliseconds). */
export interface SelfCheck {
  readonly running: boolean
  readonly endedMs: number | undefined
}

export const noSelfCheck: SelfCheck = { running: false, endedMs: undefined }

export class Published extends Context.Service<
  Published,
  {
    /** `dream publish --port <port>` went through. */
    readonly noted: (port: number) => Effect.Effect<void>
    /** The published port, once `dream publish` went through. */
    readonly port: Effect.Effect<Option.Option<number>>
    /** Load the published URL, if there is one, and tell the agent if it newly looks broken. */
    readonly checkAfterTurn: Effect.Effect<void>
    /** Whether that load is running now, and when the last one ended. */
    readonly selfCheck: Effect.Effect<SelfCheck>
  }
>()("@dream/dreamd/Published") {
  static readonly layer = Layer.effect(
    Published,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const api = yield* Api
      const pages = yield* PageCheck
      const inbox = yield* Inbox
      const file = JsonFile.make(PublishedState, path.join(config.stateDir, "published.json"))
      const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))
      const loaded = yield* provide(file.read).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Couldn't read the published port", { error: error.message }).pipe(
            Effect.as(Option.none<PublishedState>())
          )
        )
      )
      const state = yield* Ref.make(Option.getOrUndefined(loaded))
      const self = yield* Ref.make(noSelfCheck)
      const save = (next: PublishedState | undefined) =>
        Effect.gen(function* () {
          yield* Ref.set(state, next)
          const written =
            next === undefined
              ? fs.remove(file.path, { force: true }).pipe(Effect.mapError((error) => error.message))
              : provide(file.write(next)).pipe(Effect.mapError((error) => error.message))
          yield* written.pipe(Effect.catch((error) => Effect.logWarning("Couldn't save the published port", { error })))
        })

      const check = Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current === undefined) return
        const url = yield* api
          .publishedUrl(current.port)
          .pipe(
            Effect.catchTag("InvalidRequest", (error) =>
              Effect.logInfo("The API won't publish the noted port; forgetting it", { error: error.message }).pipe(
                Effect.andThen(save(undefined)),
                Effect.as(undefined)
              )
            )
          )
        if (url === undefined) return
        const load = yield* pages.check(url)
        const key = brokenKey(load)
        if (key === undefined) {
          if (current.reported !== undefined) yield* Effect.logInfo("The published URL looks healthy again", { url })
          return yield* save({ port: current.port })
        }
        if (key === current.reported) return
        const event = AgentEvent.cases.PublishedUrlBroken.make({
          id: EventId.make(`evt_dreamd_${randomUUID()}`),
          at: yield* DateTime.now,
          url,
          port: current.port,
          facts: pageCheck(load)
        })
        yield* inbox.deliver([event])
        yield* save({ port: current.port, reported: key })
        yield* Effect.logInfo("The published URL looks broken; told the agent", { url, event: event.id })
      })

      return Published.of({
        port: Effect.map(Ref.get(state), (current) => Option.fromUndefinedOr(current?.port)),
        noted: (port) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(state)
            if (current?.port !== port) yield* save({ port })
          }),
        checkAfterTurn: Ref.update(self, (s) => ({ ...s, running: true })).pipe(
          Effect.andThen(check),
          Effect.catchCause((cause) => Effect.logWarning("Couldn't check the published URL", cause)),
          Effect.ensuring(
            Effect.flatMap(Clock.currentTimeMillis, (endedMs) => Ref.set(self, { running: false, endedMs }))
          )
        ),
        selfCheck: Ref.get(self)
      })
    })
  )

  /** Nothing is published. */
  static readonly layerNone = Layer.succeed(Published, {
    port: Effect.succeed(Option.none()),
    noted: () => Effect.void,
    checkAfterTurn: Effect.void,
    selfCheck: Effect.succeed(noSelfCheck)
  })
}
