/**
 * E2B sandbox time in the ledger: each paused or killed lifecycle event is one billed run, recorded as a
 * `sandbox_run`. Events arrive by the Worker's own webhook (`Routes.e2bWebhook`), and an hourly backfill reads
 * `GET /events/sandboxes` for whatever a delivery missed; both use E2B's event id, so a run is recorded once.
 *
 * The webhook's signing secret is generated here and kept sealed in D1 (`meter_webhooks`); `register` creates or
 * updates the webhook with it, and calling it again rotates it. Deliveries signed with the secret just replaced
 * still verify, so nothing is lost while E2B switches over.
 */
import { ProjectId, UpstreamFailure } from "@dream/domain"
import { Context, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ApiConfig } from "../Config.ts"
import { Projects } from "../db/Projects.ts"
import { decodeFirst, exec, nowIso } from "../db/Sql.ts"
import { randomBytes, timingSafeEqual, toBase64, toBase64Url, utf8 } from "../lib/Bytes.ts"
import { makeSecretBox } from "../lib/SecretBox.ts"
import { BilledTypes, E2BEvents, type LifecycleEvent, toMeterEvent, WebhookBody, fromWebhook } from "./E2BEvents.ts"
import { Meter, type MeterEvent, OperatorOwner } from "./Meter.ts"

/** How far back the hourly backfill looks; once a day it reads everything E2B still has. */
export const BackfillWindow = Duration.hours(25)
export const BackfillRetention = Duration.days(7)
const PageSize = 100
const MaxPages = 200

const Secrets = Schema.Struct({ current: Schema.String, previous: Schema.optionalKey(Schema.String) })
const SecretsJson = Schema.fromJsonString(Secrets)

const WebhookRow = Schema.Struct({
  webhook_id: Schema.String,
  url: Schema.String,
  key_version: Schema.Int,
  wrapped_key: Schema.String,
  key_nonce: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String
})

const aad = "dream-meter-webhook:v1:e2b"

/** E2B's `e2b-signature`: base64 SHA-256 of the secret followed by the raw body, without `=` padding. */
export const e2bSignature = (secret: string, body: Uint8Array) =>
  Effect.promise(async () => {
    const key = utf8(secret)
    const joined = new Uint8Array(key.length + body.length)
    joined.set(key)
    joined.set(body, key.length)
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", joined))
    return toBase64(digest).replace(/=+$/, "")
  })

export type WebhookOutcome =
  | { readonly _tag: "Unauthorized" }
  | { readonly _tag: "Malformed" }
  | { readonly _tag: "Recorded"; readonly metered: boolean }

export interface RegisteredWebhook {
  readonly webhookId: string
  readonly url: string
  readonly events: ReadonlyArray<string>
  readonly created: boolean
}

export class E2BMetering extends Context.Service<
  E2BMetering,
  {
    /** A webhook delivery: checks its signature against the raw body, then records the run it ends, if any. */
    readonly receive: (body: Uint8Array, signature: string | undefined) => Effect.Effect<WebhookOutcome>
    /** Records every billed run E2B reports since `since` (newest first, until older). */
    readonly backfill: (since: DateTime.Utc) => Effect.Effect<{ readonly read: number }, UpstreamFailure>
    /** The hourly backfill: the last day, or at the first hour of a UTC day, all E2B still keeps. */
    readonly hourly: Effect.Effect<void>
    /** Generates a new signing secret and creates or updates the Worker's webhook with it. */
    readonly register: (url: string) => Effect.Effect<RegisteredWebhook, UpstreamFailure>
  }
>()("@dream/api/metering/E2BMetering") {
  static readonly layer = Layer.effect(
    E2BMetering,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const config = yield* ApiConfig
      const meter = yield* Meter
      const events = yield* E2BEvents
      const projects = yield* Projects
      const box = yield* makeSecretBox(Redacted.value(config.encryptionKey)).pipe(Effect.orDie)

      const stored = sql`SELECT * FROM meter_webhooks WHERE provider = 'e2b'`.pipe(decodeFirst(WebhookRow))

      const secrets = Effect.gen(function* () {
        const row = yield* stored
        if (row === undefined) return Option.none<typeof Secrets.Type>()
        const plaintext = yield* box.open(
          {
            keyVersion: row.key_version,
            wrappedKey: row.wrapped_key,
            keyNonce: row.key_nonce,
            nonce: row.nonce,
            ciphertext: row.ciphertext
          },
          aad
        )
        return Option.some(yield* Schema.decodeUnknownEffect(SecretsJson)(plaintext))
      }).pipe(Effect.orDie)

      /** A run of a project's sandbox whose metadata had no user (none should): the project's owner. */
      const owned = (event: MeterEvent) =>
        Effect.gen(function* () {
          const project = event.dimensions.project
          if (event.owner !== OperatorOwner || project === undefined) return event
          const id = Schema.decodeUnknownOption(ProjectId)(project)
          if (Option.isNone(id)) return event
          const found = yield* projects.find(id.value)
          return Option.match(found, { onNone: () => event, onSome: (p) => ({ ...event, owner: p.ownerId }) })
        })

      const recordAll = (lifecycle: ReadonlyArray<LifecycleEvent>) =>
        Effect.gen(function* () {
          const metered: Array<MeterEvent> = []
          for (const event of lifecycle) {
            const run = toMeterEvent(event)
            if (Option.isSome(run)) metered.push(yield* owned(run.value))
          }
          yield* meter.record(metered)
          return metered.length
        })

      const receive = Effect.fn("E2BMetering.receive")(function* (body: Uint8Array, signature: string | undefined) {
        if (signature === undefined || signature.length === 0) return { _tag: "Unauthorized" } as const
        const known = yield* secrets
        if (Option.isNone(known)) return { _tag: "Unauthorized" } as const
        const candidates = [known.value.current, ...(known.value.previous === undefined ? [] : [known.value.previous])]
        let valid = false
        for (const secret of candidates) {
          if (timingSafeEqual(yield* e2bSignature(secret, body), signature.replace(/=+$/, ""))) valid = true
        }
        if (!valid) return { _tag: "Unauthorized" } as const
        const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(WebhookBody))(new TextDecoder().decode(body))
        if (Option.isNone(decoded)) return { _tag: "Malformed" } as const
        const count = yield* recordAll([fromWebhook(decoded.value)])
        return { _tag: "Recorded", metered: count > 0 } as const
      })

      const backfill = Effect.fn("E2BMetering.backfill")(function* (since: DateTime.Utc) {
        const sinceMs = DateTime.toEpochMillis(since)
        let read = 0
        for (let page = 0; page < MaxPages; page++) {
          const batch = yield* events.billed(page * PageSize, PageSize)
          read += batch.length
          yield* recordAll(batch.filter((event) => Date.parse(event.timestamp) >= sinceMs))
          if (batch.length < PageSize || batch.every((event) => Date.parse(event.timestamp) < sinceMs)) break
        }
        return { read }
      })

      const hourly = Effect.gen(function* () {
        const now = yield* DateTime.now
        const firstHour = DateTime.getPartUtc(now, "hour") === 0
        const window = firstHour ? BackfillRetention : BackfillWindow
        const result = yield* backfill(DateTime.subtractDuration(now, window))
        yield* Effect.logInfo("backfilled E2B runs", { read: result.read, full: firstHour })
      }).pipe(
        Effect.catch((error) => Effect.logWarning("E2B backfill failed", error.message)),
        Effect.withSpan("E2BMetering.hourly")
      )

      const keep = (webhookId: string, url: string, value: typeof Secrets.Type) =>
        Effect.gen(function* () {
          const sealed = yield* box.seal(Schema.encodeSync(SecretsJson)(value), aad)
          const now = yield* nowIso
          yield* exec(sql`
            INSERT INTO meter_webhooks (provider, webhook_id, url, key_version, wrapped_key, key_nonce, nonce,
              ciphertext, updated_at)
            VALUES ('e2b', ${webhookId}, ${url}, ${sealed.keyVersion}, ${sealed.wrappedKey}, ${sealed.keyNonce},
              ${sealed.nonce}, ${sealed.ciphertext}, ${now})
            ON CONFLICT (provider) DO UPDATE SET webhook_id = excluded.webhook_id, url = excluded.url,
              key_version = excluded.key_version, wrapped_key = excluded.wrapped_key, key_nonce = excluded.key_nonce,
              nonce = excluded.nonce, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
        })

      const register = Effect.fn("E2BMetering.register")(function* (url: string) {
        const previous = yield* secrets
        const current = toBase64Url(randomBytes(32))
        const settings = {
          name: `dream-metering ${config.apiHost}`,
          url,
          events: BilledTypes,
          signatureSecret: Redacted.make(current)
        }
        const row = yield* stored
        // Ours if we registered it, else one already pointing at this URL (a database restored from elsewhere).
        const existing =
          row?.webhook_id ?? (yield* events.webhooks).find((webhook) => webhook.url === url)?.id ?? undefined
        // Kept first, so deliveries signed with the new secret verify from the moment E2B has it.
        const keepWith = (webhookId: string) =>
          keep(webhookId, url, {
            current,
            ...(Option.isSome(previous) ? { previous: previous.value.current } : {})
          })
        if (existing !== undefined) {
          yield* keepWith(existing)
          // If E2B didn't take the new secret it still signs with the old one: keep the secrets as they were, so a
          // retried rotation can't push the secret E2B uses out of `previous`.
          const updated = yield* events
            .updateWebhook(existing, settings)
            .pipe(
              Effect.tapError(() =>
                Option.match(previous, { onNone: () => Effect.void, onSome: (kept) => keep(existing, url, kept) })
              )
            )
          if (Option.isSome(updated)) {
            return { webhookId: updated.value.id, url, events: BilledTypes, created: false }
          }
        }
        const created = yield* events.createWebhook(settings)
        yield* keepWith(created.id)
        return { webhookId: created.id, url, events: BilledTypes, created: true }
      })

      return E2BMetering.of({ receive, backfill, hourly, register })
    })
  )
}
