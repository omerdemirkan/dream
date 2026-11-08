/**
 * Relays: a line Dream holds open on a project's behalf, from its Worker, while the sandbox sleeps.
 *
 * Some services only tell you what happened down a connection you keep open: Discord's Gateway, exchange price
 * feeds, other WebSocket streams. A sleeping sandbox can't keep one open, so the agent asks Dream to (`dream relay`).
 * A Durable Object holds the line, keeps its protocol alive (heartbeats, resume, reconnect), and turns each event
 * into a POST to the project's own app: the ProjectDO hands it to dreamd, which wakes with the request and posts it
 * to the app on localhost, signed with the sandbox's relay key. Events queue while that happens and are retried
 * until the app takes them.
 *
 * Credentials stay with Dream: a relay names one of their `Key` integrations, which the Worker decrypts to log in
 * (Discord) or to send as the connection's header (a WebSocket feed). The sandbox never sees the value.
 */
import { Schema } from "effect"
import { IntegrationId, RelayId } from "./Ids.ts"

/** How many relays one project can have. Each holds a connection open around the clock. */
export const RelaysPerProject = 3

/** Events waiting for the app, per relay; past this the oldest are dropped (and counted). */
export const RelayQueueLimit = 500

/** An event bigger than this (its JSON, in bytes) is dropped instead of delivered. */
export const RelayEventMaxBytes = 256 * 1024

/** An event the app hasn't taken within this many hours is dropped. */
export const RelayEventMaxAgeHours = 24

/** Where dreamd keeps the key it signs deliveries with. Apps read it to check that a delivery came from Dream. */
export const RelayKeyPath = "/home/user/.dream/relay.key"

/** The headers dreamd adds to each delivery. */
export const RelayHeaders = {
  /** The relay's id. */
  relay: "dream-relay",
  /** The event's id, the same on every retry, so the app can drop duplicates. */
  delivery: "dream-delivery",
  /** Unix seconds when dreamd sent this attempt. */
  timestamp: "dream-timestamp",
  /** `v1=<hex HMAC-SHA256 of "<timestamp>.<body>" with the relay key>`. */
  signature: "dream-signature"
} as const

/**
 * Discord Gateway intents a relay asks for unless told otherwise: servers (1 << 0), server messages (1 << 9),
 * direct messages (1 << 12) and message content (1 << 15, privileged: switched on in the Developer Portal).
 */
export const DiscordDefaultIntents = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

/** Gateway events a Discord relay forwards unless told otherwise. */
export const DiscordDefaultEvents: readonly [string, ...Array<string>] = ["MESSAGE_CREATE"]

export const RelayPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))

/** Why `path` can't be where a relay delivers, or `undefined` if it can. */
export const relayPathProblem = (path: string): string | undefined => {
  if (!path.startsWith("/")) return `"${path}" isn't a path; it starts with "/", like /hooks/discord.`
  if (path.length > 512) return "The path is longer than 512 characters."
  if (/[\s#]/.test(path)) return "The path can't contain spaces or a #."
  return undefined
}

export const RelayPath = Schema.String.check(Schema.makeFilter((path) => relayPathProblem(path) ?? true))

// Parsed by hand, as `linkUrlProblem` does: the domain gets no platform globals.
const feedUrlParts = /^wss:\/\/([A-Za-z0-9.-]+)(:[0-9]{1,5})?([/?][^\s#]*)?$/i

/** A WebSocket feed URL's host, lowercased, or `undefined` if it isn't one a relay can open. */
export const relayUrlHost = (url: string): string | undefined => feedUrlParts.exec(url)?.[1]?.toLowerCase()

/** Why `url` can't be a WebSocket relay's feed, or `undefined` if it can. */
export const relayUrlProblem = (url: string): string | undefined => {
  if (!/^wss:\/\//i.test(url)) return `The feed's URL starts with wss://; "${url}" doesn't.`
  if (/^wss:\/\/[^/?]*@/i.test(url)) {
    return "Credentials don't go in the URL. Ask for a key with `dream access key` and name it with --key."
  }
  const host = relayUrlHost(url)
  if (host === undefined) return `"${url}" isn't a URL a relay can open (wss://, a host name, then a path).`
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return "The feed needs a public host name."
  return undefined
}

export const RelayUrl = Schema.String.check(Schema.makeFilter((url) => relayUrlProblem(url) ?? true))

/** Where a relay's events come from. */
export const RelaySource = Schema.TaggedUnion({
  /** A Discord bot's Gateway session. */
  Discord: {
    /**
     * The `Key` integration holding the bot token (host discord.com, header Authorization, format "Bot {key}"), the
     * same one their REST calls use. Absent in a request when they have exactly one; Dream fills it in.
     */
    integrationId: Schema.optionalKey(IntegrationId),
    intents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    /** Dispatch event names to forward, e.g. MESSAGE_CREATE. */
    events: Schema.NonEmptyArray(Schema.NonEmptyString),
    /** Forward only messages that mention the bot, reply to it, or are sent to it directly. */
    mentionsOnly: Schema.Boolean,
    /** Forward only events in these channels. */
    channels: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
  },
  /** Any WebSocket feed: subscribe on connect, forward what arrives. */
  WebSocket: {
    url: RelayUrl,
    /** Sent after every connect, in order: subscribe messages, usually. */
    send: Schema.Array(Schema.String),
    /** A `Key` integration whose header goes on the connection request. Its host has to be the URL's. */
    integrationId: Schema.optionalKey(IntegrationId),
    /** Sent every `everySeconds`, for feeds that drop clients that say nothing. */
    ping: Schema.optionalKey(
      Schema.Struct({
        message: Schema.String,
        everySeconds: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 3600 }))
      })
    ),
    /** Reconnect when nothing arrives for this long. */
    silenceSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 86400 }))),
    /** Forward only messages containing this text. */
    match: Schema.optionalKey(Schema.NonEmptyString)
  }
})
export type RelaySource = typeof RelaySource.Type

export const RelayTarget = Schema.Struct({
  /** The path each event is POSTed to, e.g. /hooks/discord. */
  path: RelayPath,
  /** The app's port in the sandbox. Absent means the published port, whichever it is at the time. */
  port: Schema.optionalKey(RelayPort)
})
export type RelayTarget = typeof RelayTarget.Type

/**
 * - `connecting`: logging in or opening the line.
 * - `connected`: holding it.
 * - `retrying`: the line dropped or couldn't open; it tries again, backing off up to a few minutes.
 * - `failed`: the service refused for a reason retrying won't fix (a revoked token, intents not switched on). It
 *   stays failed until `dream relay restart`, or until the key it uses is connected again.
 */
export const RelayState = Schema.Literals(["connecting", "connected", "retrying", "failed"])
export type RelayState = typeof RelayState.Type

export const RelayProblem = Schema.Struct({ at: Schema.DateTimeUtc, message: Schema.String })
export type RelayProblem = typeof RelayProblem.Type

/** A relay as `dream relay list` shows it. */
export const Relay = Schema.Struct({
  id: RelayId,
  label: Schema.optionalKey(Schema.String),
  source: RelaySource,
  target: RelayTarget,
  createdAt: Schema.DateTimeUtc,
  state: RelayState,
  /** When it entered `state`. */
  since: Schema.optionalKey(Schema.DateTimeUtc),
  /** Who it's connected as, when the service says: a Discord bot's username. */
  account: Schema.optionalKey(Schema.String),
  /** Events waiting for the app to take them. */
  waiting: Schema.Int,
  delivered: Schema.Int,
  /** Events dropped: the queue was full, an event was too big, or the app didn't take it within a day. */
  dropped: Schema.Int,
  lastEventAt: Schema.optionalKey(Schema.DateTimeUtc),
  lastDeliveredAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** Recent problems, newest first, at most five. */
  problems: Schema.Array(RelayProblem)
})
export type Relay = typeof Relay.Type

/** The JSON body of each delivery. */
export const RelayDelivery = Schema.Struct({
  /** The same on every retry (as `Dream-Delivery`). Deliveries are at least once, so drop ids you've seen. */
  id: Schema.String,
  relay: RelayId,
  source: Schema.Literals(["discord", "websocket"]),
  /** Discord's dispatch event name, e.g. MESSAGE_CREATE. */
  type: Schema.optionalKey(Schema.String),
  /** When the relay received it. */
  at: Schema.DateTimeUtc,
  /**
   * Discord: the dispatch's `d`, exactly as the Gateway sent it. WebSocket: the message, parsed if it's JSON, else
   * its text; a binary message is base64 with `binary: true`.
   */
  data: Schema.Unknown,
  binary: Schema.optionalKey(Schema.Boolean)
})
export type RelayDelivery = typeof RelayDelivery.Type

/** One event on its way from the Worker to the app, through dreamd. `body` is the `RelayDelivery` JSON, as sent. */
export const RelayForward = Schema.Struct({ id: Schema.NonEmptyString, body: Schema.String })
export type RelayForward = typeof RelayForward.Type

/** What dreamd reports after posting a batch to the app: how many it took, in order, and why the next one didn't go. */
export const RelayForwardResult = Schema.Struct({
  delivered: Schema.Int,
  /**
   * Nothing was tried because a usage limit they set holds the project: wait, up to then, without counting it a
   * failure. Set by the ProjectDO, never by dreamd. Added November 2026.
   */
  heldUntil: Schema.optionalKey(Schema.DateTimeUtc),
  failure: Schema.optionalKey(
    Schema.Struct({
      message: Schema.String,
      /** The app's HTTP status; absent when it didn't answer. */
      status: Schema.optionalKey(Schema.Int)
    })
  )
})
export type RelayForwardResult = typeof RelayForwardResult.Type
