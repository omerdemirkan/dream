/**
 * A WebSocket feed, held by a RelayDO: connect (with their key's header, if the relay names one), send the
 * subscribe messages, and hand on every message, or those containing `match`. A ping every `everySeconds` keeps
 * feeds that drop quiet clients happy, and `silenceSeconds` with nothing arriving means the line is dead even if it
 * looks open, so the relay reconnects. Every reconnect sends the subscribe messages again; a feed has no session to
 * resume, so messages sent while the line was down are missed (as with any client of such a feed).
 */
import { Duration, Effect, Exit, Option, Queue, Schema, type Scope } from "effect"
import { toBase64 } from "../lib/Bytes.ts"
import { credentialHeader } from "../project/ProjectRpcs.ts"
import { Dialer, GoingAway } from "./Dialer.ts"
import { SessionEnd, type SessionContext } from "./Session.ts"

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** Parsed if it's JSON, else the text itself. The app gets it as it came; the relay never looks inside. */
const asData = (text: string): unknown => Option.getOrElse(parseJson(text), () => text)

export const feedSession = (ctx: SessionContext): Effect.Effect<SessionEnd, never, Dialer | Scope.Scope> =>
  Effect.gen(function* () {
    const source = ctx.config.source
    if (source._tag !== "WebSocket") return SessionEnd.Fatal({ reason: "This relay isn't a WebSocket relay" })
    const dialer = yield* Dialer
    const headers = Option.match(ctx.credential, {
      onNone: () => ({}),
      onSome: (credential) => Object.fromEntries([credentialHeader(credential)])
    })
    const opened = yield* dialer.open(source.url, headers).pipe(Effect.result)
    if (opened._tag === "Failure") {
      const { status, message } = opened.failure
      if (status === 401 || status === 403) {
        return SessionEnd.Fatal({
          reason: `The feed refused the connection (${status})${source.integrationId === undefined ? "; it may need a key (--key)" : "; the key may be wrong or revoked"}`
        })
      }
      return SessionEnd.Retry({ reason: `Couldn't open the feed: ${message}` })
    }
    const socket = opened.success
    yield* Effect.addFinalizer((exit) => (Exit.hasInterrupts(exit) ? socket.close(1000, "relay stopped") : Effect.void))
    yield* ctx.connected()
    for (const message of source.send) yield* socket.send(message)
    if (source.ping !== undefined) {
      const ping = source.ping
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(Duration.seconds(ping.everySeconds)).pipe(Effect.andThen(socket.send(ping.message)))
        )
      )
    }
    const silence = source.silenceSeconds === undefined ? undefined : Duration.seconds(source.silenceSeconds)
    let counter = 0
    const id = () => `ws:${crypto.randomUUID()}:${counter++}`
    while (true) {
      const next = Queue.take(socket.events)
      const event = silence === undefined ? Option.some(yield* next) : yield* next.pipe(Effect.timeoutOption(silence))
      if (Option.isNone(event)) {
        yield* socket.close(GoingAway, "silent too long")
        return SessionEnd.Retry({ reason: `Nothing arrived for ${source.silenceSeconds}s; reconnecting` })
      }
      const value = event.value
      if (value._tag === "Closed") {
        return SessionEnd.Retry({
          reason: `The feed closed the line (${value.code}${value.reason.length > 0 ? `: ${value.reason}` : ""}); reconnecting`
        })
      }
      if (value._tag === "Text") {
        if (source.match !== undefined && !value.text.includes(source.match)) continue
        yield* ctx.emit({ id: id(), data: asData(value.text) })
      } else if (source.match === undefined) {
        yield* ctx.emit({ id: id(), data: toBase64(value.data), binary: true })
      }
    }
  })
