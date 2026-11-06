/**
 * A Discord bot's Gateway session, held by a RelayDO (https://docs.discord.com/developers/events/gateway).
 *
 * The bot token comes from their `Key` integration for discord.com and is only ever sent to Discord: to the REST
 * API for the Gateway's URL, and in the Identify or Resume payload on a Gateway host. One session:
 *
 * 1. Ask `GET /gateway/bot` where to connect (or use the session's `resume_gateway_url`), connect, and wait for
 *    Hello, which says how often to heartbeat.
 * 2. Resume the stored session if there is one, else Identify with the relay's intents.
 * 3. Heartbeat every `heartbeat_interval` (the first after a random fraction of it), with the last sequence number.
 *    A heartbeat Discord hasn't acknowledged by the next one means a dead ("zombied") line: close it and resume.
 * 4. Track each dispatch's sequence number, store the session on READY, and hand on the dispatches the relay wants.
 * 5. Reconnect (op 7) and Invalid Session (op 9) end the session to resume, or to identify afresh; a close code
 *    says whether resuming is possible, or whether retrying can't help at all (a bad token, intents not allowed).
 *
 * The session survives the object restarting (a deploy): its id, resume URL and sequence are in storage, so the next
 * session resumes and Discord replays what was missed, as long as that's within the few minutes it keeps a session.
 */
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Random,
  Redacted,
  Ref,
  Schema,
  type Scope
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { RelayConfig } from "./RelayRpcs.ts"
import { Dialer, GoingAway, type LineSocket } from "./Dialer.ts"
import { SessionEnd, type SessionContext } from "./Session.ts"
import type { DiscordSession } from "./RelayStore.ts"

/** Where the relay finds Discord. The defaults are Discord's own; a test points them at a fake. */
export class DiscordEndpoints extends Context.Service<
  DiscordEndpoints,
  {
    /** REST API base, e.g. https://discord.com/api/v10. */
    readonly api: string
    /** The only host (or parent domain) the token may be sent to over the Gateway. */
    readonly gatewayHost: string
  }
>()("@dream/api/relay/DiscordEndpoints") {
  static readonly layer = Layer.succeed(DiscordEndpoints, {
    api: "https://discord.com/api/v10",
    gatewayHost: "discord.gg"
  })
  static readonly layerFrom = (api: string, gatewayHost: string) =>
    Layer.succeed(DiscordEndpoints, { api: api.replace(/\/+$/, ""), gatewayHost })
}

export const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11
} as const

/** Close codes after which retrying can't help until they change something. */
export const fatalCloseReasons: Readonly<Record<number, string>> = {
  4004: "Discord refused the bot token (4004). It may have been reset in the Developer Portal; they need to connect the new one",
  4010: "Discord refused the shard settings (4010)",
  4011: "The bot is in too many servers to connect without sharding (4011)",
  4012: "Discord no longer accepts the Gateway version Dream uses (4012)",
  4013: "The relay's intents aren't valid (4013)",
  4014: "The bot asked for intents that aren't switched on (4014). In the Developer Portal, under Bot, they switch on Message Content Intent (and any other privileged intent the relay asks for)"
}

/** Close codes after which the session can't be resumed, so the next one identifies afresh. */
export const freshCloseCodes: ReadonlySet<number> = new Set([4007, 4009])

export const GatewayPayload = Schema.Struct({
  op: Schema.Int,
  d: Schema.optionalKey(Schema.Unknown),
  s: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  t: Schema.optionalKey(Schema.NullOr(Schema.String))
})
export type GatewayPayload = typeof GatewayPayload.Type

const Hello = Schema.Struct({ heartbeat_interval: Schema.Number.check(Schema.isGreaterThan(0)) })
const Ready = Schema.Struct({
  session_id: Schema.String,
  resume_gateway_url: Schema.String,
  user: Schema.Struct({
    id: Schema.String,
    username: Schema.String,
    discriminator: Schema.optionalKey(Schema.String)
  })
})
const GatewayBot = Schema.Struct({
  url: Schema.String,
  session_start_limit: Schema.optionalKey(Schema.Struct({ remaining: Schema.Number, reset_after: Schema.Number }))
})
const RateLimited = Schema.Struct({ retry_after: Schema.Number })
/** The fields a message event is filtered on; the rest passes through untouched. */
const MessageFields = Schema.Struct({
  channel_id: Schema.optionalKey(Schema.String),
  guild_id: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) })),
  mentions: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.optionalKey(Schema.String) }))),
  referenced_message: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ author: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) })) })
    )
  )
})

const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(GatewayPayload))
const decodeHello = Schema.decodeUnknownOption(Hello)
const decodeReady = Schema.decodeUnknownOption(Ready)
const decodeMessage = Schema.decodeUnknownOption(MessageFields)

type DiscordSource = Extract<RelayConfig["source"], { readonly _tag: "Discord" }>

/** Whether the relay forwards this dispatch. A bot's own messages never go, so a bot replying can't loop. */
export const wanted = (source: DiscordSource, botUserId: string | undefined, type: string, data: unknown): boolean => {
  if (!source.events.includes(type)) return false
  const message = Option.getOrUndefined(decodeMessage(data))
  if (message === undefined) return true
  const isMessage = type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE"
  if (isMessage && botUserId !== undefined && message.author?.id === botUserId) return false
  if (source.channels !== undefined && source.channels.length > 0 && message.channel_id !== undefined) {
    if (!source.channels.includes(message.channel_id)) return false
  }
  if (source.mentionsOnly && isMessage) {
    const direct = message.guild_id === undefined
    const mentioned = botUserId !== undefined && (message.mentions ?? []).some((user) => user.id === botUserId)
    const reply = botUserId !== undefined && message.referenced_message?.author?.id === botUserId
    return direct || mentioned || reply
  }
  return true
}

/** The token as Discord wants it in Identify: without the "Bot " the REST header carries. */
export const bareToken = (key: string): string => key.trim().replace(/^Bot\s+/i, "")

/** Whether `url` is on the Gateway host (or under its domain), and so may be sent the token. */
export const onGatewayHost = (url: string, gatewayHost: string): boolean => {
  const host = /^wss:\/\/([^/:?#]+)/i.exec(url)?.[1]?.toLowerCase()
  const allowed = gatewayHost.toLowerCase()
  return host !== undefined && (host === allowed || host.endsWith(`.${allowed}`))
}

const gatewayUrl = (url: string) => `${url.replace(/\/+$/, "").replace(/\?.*$/, "")}/?v=10&encoding=json`

/** Where to connect, from `GET /gateway/bot`; or how the session should end instead. */
const findGateway = (token: string) =>
  Effect.gen(function* () {
    const endpoints = yield* DiscordEndpoints
    const http = yield* HttpClient.HttpClient
    const response = yield* http.execute(
      HttpClientRequest.get(`${endpoints.api}/gateway/bot`).pipe(
        HttpClientRequest.setHeader("authorization", `Bot ${token}`)
      )
    )
    if (response.status === 401) {
      return SessionEnd.Fatal({ reason: fatalCloseReasons[4004]! })
    }
    if (response.status === 429) {
      const limited = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(RateLimited)), Effect.option)
      const seconds = Option.match(limited, { onNone: () => 30, onSome: (body) => body.retry_after })
      return SessionEnd.Retry({
        reason: "Discord rate-limited the relay",
        wait: Duration.seconds(Math.max(1, seconds))
      })
    }
    if (response.status < 200 || response.status >= 300) {
      return SessionEnd.Retry({ reason: `Discord's API answered ${response.status} when asked for the Gateway` })
    }
    const body = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(GatewayBot)))
    const limit = body.session_start_limit
    if (limit !== undefined && limit.remaining <= 0) {
      return SessionEnd.Retry({
        reason: "The bot has used up today's Gateway logins; the relay waits for Discord to allow more",
        wait: Duration.millis(Math.max(1000, limit.reset_after))
      })
    }
    return body.url
  }).pipe(
    Effect.scoped,
    Effect.catch((error) =>
      Effect.succeed(SessionEnd.Retry({ reason: `Couldn't ask Discord for the Gateway: ${error.message}` }))
    )
  )

/** Runs one Gateway session until it ends. */
export const discordSession = (
  ctx: SessionContext
): Effect.Effect<SessionEnd, never, Dialer | DiscordEndpoints | HttpClient.HttpClient | Scope.Scope> =>
  Effect.gen(function* () {
    const source = ctx.config.source
    if (source._tag !== "Discord") return SessionEnd.Fatal({ reason: "This relay isn't a Discord relay" })
    if (Option.isNone(ctx.credential)) return SessionEnd.Fatal({ reason: "There's no Discord bot key to log in with" })
    const token = bareToken(Redacted.value(ctx.credential.value.key))
    const endpoints = yield* DiscordEndpoints
    const dialer = yield* Dialer

    const saved = yield* ctx.discord.get
    let url: string
    if (Option.isSome(saved) && onGatewayHost(saved.value.resumeUrl, endpoints.gatewayHost)) {
      url = saved.value.resumeUrl
    } else {
      const found = yield* findGateway(token)
      if (typeof found !== "string") return found
      url = found
    }
    if (!onGatewayHost(url, endpoints.gatewayHost)) {
      return SessionEnd.Fatal({
        reason: `Discord pointed the relay at an unexpected host (${url}); it won't send the token there`
      })
    }

    const opened = yield* dialer.open(gatewayUrl(url), {}).pipe(Effect.result)
    if (opened._tag === "Failure")
      return SessionEnd.Retry({ reason: `Couldn't open the Gateway: ${opened.failure.message}` })
    const socket: LineSocket = opened.success
    // Stopped or restarted on purpose: end the session for good (1000), rather than leave it resumable.
    yield* Effect.addFinalizer((exit) => (Exit.hasInterrupts(exit) ? socket.close(1000, "relay stopped") : Effect.void))

    const send = (payload: unknown) => socket.send(JSON.stringify(payload))
    const next = Queue.take(socket.events)

    // 1. Hello.
    const hello = yield* next.pipe(Effect.timeoutOption("30 seconds"))
    if (Option.isNone(hello)) return SessionEnd.Retry({ reason: "The Gateway didn't say hello within 30 seconds" })
    if (hello.value._tag === "Closed") return yield* closedEnd(hello.value.code, hello.value.reason, ctx)
    const helloPayload =
      hello.value._tag === "Text" ? Option.getOrUndefined(decodePayload(hello.value.text)) : undefined
    const interval = helloPayload?.op === Op.Hello ? Option.getOrUndefined(decodeHello(helloPayload.d)) : undefined
    if (interval === undefined) return SessionEnd.Retry({ reason: "The Gateway's first message wasn't Hello" })

    // 2. Resume or identify.
    const session = yield* Ref.make<Option.Option<DiscordSession>>(saved)
    const seq = yield* Ref.make<number | null>(Option.isSome(saved) ? saved.value.seq : null)
    if (Option.isSome(saved)) {
      yield* send({ op: Op.Resume, d: { token, session_id: saved.value.sessionId, seq: saved.value.seq } })
    } else {
      yield* send({
        op: Op.Identify,
        d: { token, intents: source.intents, properties: { os: "linux", browser: "dream", device: "dream" } }
      })
    }

    // 3. Heartbeats, until one goes unacknowledged.
    const acked = yield* Ref.make(true)
    const zombie = yield* Deferred.make<SessionEnd>()
    const heartbeat = Effect.flatMap(Ref.get(seq), (d) => send({ op: Op.Heartbeat, d }))
    yield* Effect.gen(function* () {
      const jitter = yield* Random.next
      yield* Effect.sleep(Duration.millis(Math.floor(interval.heartbeat_interval * jitter)))
      while (true) {
        if (!(yield* Ref.get(acked))) {
          yield* socket.close(GoingAway, "no heartbeat ack")
          return yield* Deferred.succeed(
            zombie,
            SessionEnd.Retry({ reason: "Discord stopped acknowledging heartbeats; resuming" })
          )
        }
        yield* Ref.set(acked, false)
        yield* heartbeat
        yield* Effect.sleep(Duration.millis(interval.heartbeat_interval))
      }
    }).pipe(Effect.forkScoped)

    const persist = (update: (current: DiscordSession) => DiscordSession) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(session)
        if (Option.isNone(current)) return
        const next = Option.some(update(current.value))
        yield* Ref.set(session, next)
        yield* ctx.discord.set(next)
      })

    // 4. Dispatches and control messages.
    const handle = (payload: GatewayPayload): Effect.Effect<SessionEnd | undefined> =>
      Effect.gen(function* () {
        switch (payload.op) {
          case Op.Dispatch: {
            const s = payload.s ?? null
            if (s !== null) yield* Ref.set(seq, s)
            const type = payload.t ?? undefined
            if (type === "READY") {
              const ready = Option.getOrUndefined(decodeReady(payload.d))
              if (ready === undefined) return undefined
              const stored: DiscordSession = {
                sessionId: ready.session_id,
                resumeUrl: ready.resume_gateway_url,
                seq: s ?? 0,
                botUserId: ready.user.id
              }
              yield* Ref.set(session, Option.some(stored))
              yield* ctx.discord.set(Option.some(stored))
              const tag =
                ready.user.discriminator === undefined || ready.user.discriminator === "0"
                  ? ""
                  : `#${ready.user.discriminator}`
              yield* ctx.connected(`${ready.user.username}${tag}`)
              return undefined
            }
            if (s !== null) yield* persist((current) => ({ ...current, seq: s }))
            if (type === "RESUMED") {
              yield* ctx.connected()
              return undefined
            }
            if (type === undefined) return undefined
            const current = yield* Ref.get(session)
            const botUserId = Option.getOrUndefined(current)?.botUserId
            if (!wanted(source, botUserId, type, payload.d)) return undefined
            const sessionId = Option.getOrUndefined(current)?.sessionId ?? "unknown"
            yield* ctx.emit({
              id: `discord:${sessionId}:${s ?? (yield* Clock.currentTimeMillis)}`,
              type,
              data: payload.d
            })
            return undefined
          }
          case Op.Heartbeat:
            yield* heartbeat
            return undefined
          case Op.HeartbeatAck:
            yield* Ref.set(acked, true)
            return undefined
          case Op.Reconnect:
            yield* socket.close(GoingAway, "reconnect requested")
            return SessionEnd.Retry({ reason: "Discord asked for a reconnect", quiet: true, wait: Duration.zero })
          case Op.InvalidSession: {
            const resumable = payload.d === true
            if (!resumable) {
              yield* Ref.set(session, Option.none())
              yield* ctx.discord.set(Option.none())
            }
            yield* socket.close(GoingAway, "invalid session")
            const wait = Duration.millis(yield* Random.nextIntBetween(1000, 5000))
            return SessionEnd.Retry({
              reason: resumable
                ? "Discord asked the relay to resume again"
                : "Discord ended the session; logging in again",
              quiet: true,
              wait
            })
          }
          default:
            return undefined
        }
      })

    const read: Effect.Effect<SessionEnd> = Effect.gen(function* () {
      while (true) {
        const event = yield* next
        if (event._tag === "Closed") return yield* closedEnd(event.code, event.reason, ctx)
        if (event._tag !== "Text") continue
        const payload = decodePayload(event.text)
        if (Option.isNone(payload)) continue
        const ended = yield* handle(payload.value)
        if (ended !== undefined) return ended
      }
    })

    return yield* Effect.raceFirst(read, Deferred.await(zombie))
  })

/** How a session ends when the Gateway closes the line with `code`. */
const closedEnd = (code: number, reason: string, ctx: SessionContext): Effect.Effect<SessionEnd> =>
  Effect.gen(function* () {
    const fatal = fatalCloseReasons[code]
    if (fatal !== undefined) {
      yield* ctx.discord.set(Option.none())
      return SessionEnd.Fatal({ reason: fatal })
    }
    const detail = `${code}${reason.length > 0 ? `: ${reason}` : ""}`
    if (freshCloseCodes.has(code)) {
      yield* ctx.discord.set(Option.none())
      return SessionEnd.Retry({ reason: `The Gateway ended the session (${detail}); logging in again` })
    }
    return SessionEnd.Retry({ reason: `The Gateway line closed (${detail}); resuming` })
  })
