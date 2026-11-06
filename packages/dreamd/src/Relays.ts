/**
 * Relay deliveries, the sandbox's end. A relay in Dream's Worker holds a line open while the sandbox sleeps (see
 * `@dream/domain` `Relay.ts`); for each event it receives, the ProjectDO calls `ForwardRelay` here, and that request
 * wakes the sandbox. dreamd posts each event to the app on localhost, in order, and reports how many the app took.
 *
 * Each delivery is signed with the relay key (`RelayKeyPath`), which dreamd makes the first time it starts in a
 * sandbox and the app reads to check that a request came from Dream: the app's route may also be reachable on the
 * public URL, where anyone could post to it. The signature covers the timestamp and the exact body.
 *
 * While a delivery is under way the sandbox counts as busy (`Awake`), so it stays up until the app has answered,
 * and it may go back to sleep soon after.
 */
import { createHmac, randomBytes } from "node:crypto"
import { RelayHeaders, type RelayForward, type RelayForwardResult, type RelayId } from "@dream/domain"
import { Clock, Context, Duration, Effect, FileSystem, Layer, Path, PubSub, Ref, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { DreamdConfig } from "./Config.ts"

/** How long the app has to answer one delivery. */
export const DeliveryTimeout = Duration.minutes(2)

/** The `Dream-Signature` value for a body sent at `timestamp` (Unix seconds). */
export const relaySignature = (key: string, timestamp: number, body: string): string =>
  `v1=${createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex")}`

export interface ForwardRequest {
  readonly relayId: RelayId
  readonly port: number
  readonly path: string
  readonly deliveries: ReadonlyArray<RelayForward>
}

export class RelayForwarder extends Context.Service<
  RelayForwarder,
  {
    /** POST each delivery to the app, in order, stopping at the first it doesn't take. */
    readonly forward: (request: ForwardRequest) => Effect.Effect<RelayForwardResult>
    /** Whether a delivery is under way now. */
    readonly busy: Effect.Effect<boolean>
    /** Emits each time a batch of deliveries is done. */
    readonly finished: Stream.Stream<void>
  }
>()("@dream/dreamd/RelayForwarder") {
  static readonly layer = Layer.effect(
    RelayForwarder,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const http = yield* HttpClient.HttpClient
      const inFlight = yield* Ref.make(0)
      const done = yield* PubSub.unbounded<void>()

      /** The relay key, made on first use: 32 random bytes as hex, mode 0600 in a 0700 directory. */
      const key = Effect.gen(function* () {
        const existing = yield* fs.readFileString(config.relayKeyPath).pipe(Effect.option)
        if (existing._tag === "Some" && existing.value.trim().length > 0) return existing.value.trim()
        const dir = path.dirname(config.relayKeyPath)
        yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
        const partial = `${config.relayKeyPath}.${process.pid}.partial`
        const value = randomBytes(32).toString("hex")
        yield* fs.writeFileString(partial, `${value}\n`, { mode: 0o600 })
        yield* fs.rename(partial, config.relayKeyPath)
        yield* Effect.logInfo("Made the relay key", { path: config.relayKeyPath })
        return value
      }).pipe(Effect.orDie)
      // Made at start, so the app can read it before the first delivery.
      yield* key

      const post = (request: ForwardRequest, delivery: RelayForward, secret: string) =>
        Effect.gen(function* () {
          const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000)
          const response = yield* http.execute(
            HttpClientRequest.post(`http://localhost:${request.port}${request.path}`).pipe(
              HttpClientRequest.setHeaders({
                [RelayHeaders.relay]: request.relayId,
                [RelayHeaders.delivery]: delivery.id,
                [RelayHeaders.timestamp]: String(timestamp),
                [RelayHeaders.signature]: relaySignature(secret, timestamp, delivery.body)
              }),
              HttpClientRequest.bodyText(delivery.body, "application/json")
            )
          )
          if (response.status >= 200 && response.status < 300) return undefined
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          const firstLine = text.trim().split("\n")[0]?.slice(0, 200) ?? ""
          return {
            status: response.status,
            message: `The app answered ${response.status}${firstLine.length > 0 ? `: ${firstLine}` : ""}.`
          }
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: DeliveryTimeout,
            orElse: () =>
              Effect.succeed({ message: `The app didn't answer within ${Duration.format(DeliveryTimeout)}.` })
          }),
          Effect.catch((error) =>
            Effect.succeed({
              message: `Couldn't reach the app on port ${request.port}: ${error.message}. Is it running?`
            })
          )
        )

      const send = (request: ForwardRequest) =>
        Effect.gen(function* () {
          const secret = yield* key
          let delivered = 0
          for (const delivery of request.deliveries) {
            const failure = yield* post(request, delivery, secret)
            if (failure !== undefined) {
              yield* Effect.logWarning("A relay delivery didn't go through", {
                relay: request.relayId,
                delivery: delivery.id,
                ...failure
              })
              return { delivered, failure }
            }
            delivered++
          }
          yield* Effect.logInfo("Relay deliveries went through", { relay: request.relayId, delivered })
          return { delivered }
        })

      const forward = (request: ForwardRequest) =>
        Ref.update(inFlight, (n) => n + 1).pipe(
          Effect.andThen(send(request)),
          Effect.ensuring(Ref.update(inFlight, (n) => n - 1).pipe(Effect.andThen(PubSub.publish(done, undefined))))
        )

      return RelayForwarder.of({
        forward,
        busy: Effect.map(Ref.get(inFlight), (n) => n > 0),
        finished: Stream.fromPubSub(done)
      })
    })
  )

  /** Takes everything and does nothing: for tests that don't look at relays. */
  static readonly layerNone = Layer.succeed(
    RelayForwarder,
    RelayForwarder.of({
      forward: (request) => Effect.succeed({ delivered: request.deliveries.length }),
      busy: Effect.succeed(false),
      finished: Stream.empty
    })
  )
}
