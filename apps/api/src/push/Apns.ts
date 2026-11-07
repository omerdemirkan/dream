/**
 * APNs, straight from the Worker: alert pushes (with categories and Dream's
 * deep-link data under `PushDataKey`), silent pushes that tell the app to
 * remove withdrawn notifications, and Live Activity pushes (push-to-start,
 * update, end).
 *
 * The provider token is an ES256 JWT signed with the team's .p8 key. APNs
 * rejects tokens regenerated more than about every 20 minutes, so one token is
 * kept per isolate and reused for 40 minutes.
 *
 * Local workerd can't speak HTTP/2 to APNs; this only works deployed.
 */
import {
  LiveActivityAttributes,
  LiveActivityAttributesType,
  LiveActivityContent,
  NotificationCategory,
  PushData,
  PushDataKey,
  UpstreamFailure
} from "@dream/domain"
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ApiConfig, required } from "../Config.ts"
import { importEs256Pem, signEs256 } from "../lib/Jwt.ts"

export type PushResult = "sent" | "unregistered"

export interface AlertPush {
  readonly id: string
  readonly title: string
  /** A bold line under the title (an app notification's headline). */
  readonly subtitle?: string | undefined
  readonly body: string
  readonly category: NotificationCategory
  readonly threadId: string
  readonly data: PushData
  /** A newer alert with the same collapse id replaces the older one on the lock screen (at most 64 bytes). */
  readonly collapseId?: string | undefined
  /** `passive`: delivered to Notification Center without a sound or lighting the screen. */
  readonly passive?: boolean | undefined
}

export type LiveActivityPush =
  | {
      readonly event: "start"
      readonly attributes: LiveActivityAttributes
      readonly content: LiveActivityContent
      readonly alert: { readonly title: string; readonly body: string }
    }
  | { readonly event: "update"; readonly content: LiveActivityContent; readonly urgent: boolean }
  | { readonly event: "end"; readonly content?: LiveActivityContent | undefined; readonly dismissAfterSeconds: number }

const ApnsError = Schema.Struct({ reason: Schema.String })

let providerToken: { readonly token: string; readonly issuedAtMs: number; readonly keyId: string } | undefined

const encodeContent = Schema.encodeSync(Schema.toCodecJson(LiveActivityContent))
const encodeAttributes = Schema.encodeSync(Schema.toCodecJson(LiveActivityAttributes))
const encodePushData = Schema.encodeSync(Schema.toCodecJson(PushData))

/** The JSON body APNs gets for an alert: `aps`, and Dream's data under `PushDataKey`. */
export const alertPayload = (push: AlertPush): object => ({
  aps: {
    alert: {
      title: push.title,
      ...(push.subtitle === undefined ? {} : { subtitle: push.subtitle }),
      body: push.body
    },
    ...(push.passive === true ? { "interruption-level": "passive" } : { sound: "default" }),
    "thread-id": push.threadId,
    category: push.category,
    "mutable-content": 1
  },
  [PushDataKey]: encodePushData(push.data)
})

export class Apns extends Context.Service<
  Apns,
  {
    readonly alert: (deviceToken: string, push: AlertPush) => Effect.Effect<PushResult, UpstreamFailure>
    readonly silent: (deviceToken: string, data: PushData) => Effect.Effect<PushResult, UpstreamFailure>
    readonly liveActivity: (token: string, push: LiveActivityPush) => Effect.Effect<PushResult, UpstreamFailure>
  }
>()("@dream/api/Apns") {
  static readonly layer = Layer.effect(
    Apns,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const http = yield* HttpClient.HttpClient
      const host =
        config.apnsEnvironment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com"

      const bearer = Effect.gen(function* () {
        const keyId = yield* required(config.apnsKeyId, "APNs", "APNS_KEY_ID")
        const teamId = yield* required(config.apnsTeamId, "APNs", "APNS_TEAM_ID")
        const pem = yield* required(config.apnsPrivateKey, "APNs", "APNS_PRIVATE_KEY")
        const now = yield* Clock.currentTimeMillis
        if (
          providerToken !== undefined &&
          providerToken.keyId === keyId &&
          now - providerToken.issuedAtMs < 40 * 60 * 1000
        ) {
          return providerToken.token
        }
        const key = yield* importEs256Pem(Redacted.value(pem)).pipe(
          Effect.mapError(
            () => new UpstreamFailure({ service: "APNs", message: "APNS_PRIVATE_KEY isn't a valid .p8 key" })
          )
        )
        const token = yield* signEs256(key, { kid: keyId }, { iss: teamId, iat: Math.floor(now / 1000) })
        providerToken = { token, issuedAtMs: now, keyId }
        return token
      })

      const send = Effect.fn("Apns.send")(function* (
        deviceToken: string,
        payload: object,
        headers: {
          readonly pushType: "alert" | "background" | "liveactivity"
          readonly priority: 5 | 10
          readonly id?: string | undefined
          readonly collapseId?: string | undefined
          readonly expirationS?: number | undefined
        }
      ) {
        const bundleId = yield* required(config.apnsBundleId, "APNs", "APNS_BUNDLE_ID")
        const token = yield* bearer
        const topic = headers.pushType === "liveactivity" ? `${bundleId}.push-type.liveactivity` : bundleId
        const response = yield* HttpClientRequest.post(`${host}/3/device/${deviceToken}`).pipe(
          HttpClientRequest.setHeaders({
            authorization: `bearer ${token}`,
            "apns-topic": topic,
            "apns-push-type": headers.pushType,
            "apns-priority": String(headers.priority),
            ...(headers.id === undefined ? {} : { "apns-id": headers.id }),
            ...(headers.collapseId === undefined ? {} : { "apns-collapse-id": headers.collapseId }),
            ...(headers.expirationS === undefined ? {} : { "apns-expiration": String(headers.expirationS) })
          }),
          HttpClientRequest.bodyJsonUnsafe(payload),
          http.execute,
          Effect.mapError(
            (cause) => new UpstreamFailure({ service: "APNs", message: `request failed: ${String(cause)}` })
          )
        )
        if (response.status === 200) return "sent" as const
        const reason = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ApnsError)),
          Effect.map((body) => body.reason),
          Effect.orElseSucceed(() => `HTTP ${response.status}`)
        )
        if (response.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
          return "unregistered" as const
        }
        if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") providerToken = undefined
        return yield* new UpstreamFailure({ service: "APNs", message: reason })
      })

      const alert = (deviceToken: string, push: AlertPush) =>
        send(deviceToken, alertPayload(push), {
          pushType: "alert",
          priority: push.passive === true ? 5 : 10,
          id: push.id,
          collapseId: push.collapseId
        })

      const silent = (deviceToken: string, data: PushData) =>
        send(
          deviceToken,
          { aps: { "content-available": 1 }, [PushDataKey]: encodePushData(data) },
          { pushType: "background", priority: 5 }
        )

      const liveActivity = Effect.fn("Apns.liveActivity")(function* (token: string, push: LiveActivityPush) {
        const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000)
        switch (push.event) {
          case "start":
            return yield* send(
              token,
              {
                aps: {
                  timestamp,
                  event: "start",
                  "content-state": encodeContent(push.content),
                  "attributes-type": LiveActivityAttributesType,
                  attributes: encodeAttributes(push.attributes),
                  alert: { title: push.alert.title, body: push.alert.body }
                }
              },
              { pushType: "liveactivity", priority: 10 }
            )
          case "update":
            return yield* send(
              token,
              { aps: { timestamp, event: "update", "content-state": encodeContent(push.content) } },
              { pushType: "liveactivity", priority: push.urgent ? 10 : 5 }
            )
          case "end":
            return yield* send(
              token,
              {
                aps: {
                  timestamp,
                  event: "end",
                  ...(push.content === undefined ? {} : { "content-state": encodeContent(push.content) }),
                  "dismissal-date": timestamp + push.dismissAfterSeconds
                }
              },
              { pushType: "liveactivity", priority: 10 }
            )
        }
      })

      return Apns.of({ alert, silent, liveActivity })
    })
  )

  /** Records pushes instead of sending them. */
  static readonly layerTest = (
    sent: Array<{ readonly token: string; readonly kind: string; readonly payload: unknown }>
  ) =>
    Layer.succeed(
      Apns,
      Apns.of({
        alert: (token, push) =>
          Effect.sync(() => (sent.push({ token, kind: "alert", payload: push }), "sent" as const)),
        silent: (token, data) =>
          Effect.sync(() => (sent.push({ token, kind: "silent", payload: data }), "sent" as const)),
        liveActivity: (token, push) =>
          Effect.sync(() => (sent.push({ token, kind: `live:${push.event}`, payload: push }), "sent" as const))
      })
    )
}
