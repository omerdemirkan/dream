/**
 * The over-the-air update tables (migration 0006): releases per runtime version, the builds' last check-ins, and
 * the signing key, sealed with the master key and decrypted only to sign a response (see http/Updates.ts).
 */
import {
  type RuntimeVersion,
  UpdateAsset,
  type UpdateChannel,
  type UpdateCheckIn,
  type UpdatePlatform,
  UpdateRelease
} from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ApiConfig } from "../Config.ts"
import type { WebCryptoKey } from "../lib/Bytes.ts"
import { generateSigningKey, importSigningKey } from "../lib/CodeSigning.ts"
import { makeSecretBox } from "../lib/SecretBox.ts"
import { decodeFirst, decodeRows, exec, IsoDate, iso, jsonCodec, nullable } from "./Sql.ts"

/** What an update is made of, stored with its release. */
export const UpdateContent = Schema.Struct({
  launchAsset: UpdateAsset,
  assets: Schema.Array(UpdateAsset),
  expoClient: Schema.Record(Schema.String, Schema.Unknown)
})
export type UpdateContent = typeof UpdateContent.Type

export interface RuntimeKey {
  readonly channel: UpdateChannel
  readonly platform: UpdatePlatform
  readonly runtimeVersion: RuntimeVersion
}

export interface StoredRelease {
  readonly release: UpdateRelease
  /** Present for `Update` releases. */
  readonly content: Option.Option<UpdateContent>
}

const ReleaseRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["update", "rollback_to_embedded"]),
  created_at: IsoDate,
  content_json: nullable(Schema.String),
  git_commit: nullable(Schema.String),
  message: nullable(Schema.String),
  republish_of: nullable(Schema.String)
})

const CheckInRow = Schema.Struct({
  runtime_version: Schema.String,
  platform: Schema.String,
  last_check_at: IsoDate,
  running_update_id: nullable(Schema.String),
  embedded_update_id: nullable(Schema.String)
})

const KeyRow = Schema.Struct({
  certificate_pem: Schema.String,
  key_version: Schema.Int,
  wrapped_key: Schema.String,
  key_nonce: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String
})

const contentCodec = jsonCodec(UpdateContent)
const keyName = "main"
const keyAad = `dream-updates-signing-key:v1:${keyName}`

const toStored = (row: typeof ReleaseRow.Type): Effect.Effect<StoredRelease> =>
  Effect.gen(function* () {
    if (row.kind === "rollback_to_embedded") {
      return {
        release: UpdateRelease.cases.RollBackToEmbedded.make({ id: row.id, createdAt: row.created_at }),
        content: Option.none()
      }
    }
    const content = yield* Schema.decodeEffect(contentCodec)(row.content_json ?? "").pipe(Effect.orDie)
    return {
      release: UpdateRelease.cases.Update.make({
        id: row.id,
        createdAt: row.created_at,
        gitCommit: row.git_commit ?? "",
        message: row.message ?? "",
        ...(row.republish_of === null ? {} : { republishOf: row.republish_of })
      }),
      content: Option.some(content)
    }
  })

export class UpdateStore extends Context.Service<
  UpdateStore,
  {
    /** Newest first. */
    readonly releases: (key: RuntimeKey, limit: number) => Effect.Effect<ReadonlyArray<StoredRelease>>
    readonly release: (key: RuntimeKey, id: string) => Effect.Effect<Option.Option<StoredRelease>>
    /** Stores a release created at `createdAt` (or later, so a runtime version's releases are strictly ordered). */
    readonly append: (key: RuntimeKey, release: StoredRelease) => Effect.Effect<StoredRelease>
    readonly checkIn: (key: RuntimeKey, checkIn: UpdateCheckIn) => Effect.Effect<void>
    /** Every runtime version on the channel with a release or a check-in. */
    readonly runtimes: (
      channel: UpdateChannel
    ) => Effect.Effect<
      ReadonlyArray<{ readonly runtimeVersion: string; readonly platform: string; readonly checkIn?: UpdateCheckIn }>
    >
    /** The signing key and its certificate, if one has been created. */
    readonly signingKey: Effect.Effect<Option.Option<{ readonly certificatePem: string; readonly key: WebCryptoKey }>>
    readonly certificate: Effect.Effect<Option.Option<string>>
    /** Creates the signing key unless there is one. Never replaces it: builds embed its certificate. */
    readonly ensureSigningKey: Effect.Effect<{ readonly certificatePem: string; readonly created: boolean }>
  }
>()("@dream/api/UpdateStore") {
  static readonly layer = Layer.effect(
    UpdateStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const config = yield* ApiConfig
      const box = yield* makeSecretBox(Redacted.value(config.encryptionKey)).pipe(Effect.orDie)

      const releases = Effect.fn("UpdateStore.releases")(function* (key: RuntimeKey, limit: number) {
        const rows = yield* sql`
          SELECT * FROM update_releases
          WHERE channel = ${key.channel} AND platform = ${key.platform} AND runtime_version = ${key.runtimeVersion}
          ORDER BY created_at DESC LIMIT ${limit}`.pipe(decodeRows(ReleaseRow))
        return yield* Effect.forEach(rows, toStored)
      })

      const release = Effect.fn("UpdateStore.release")(function* (key: RuntimeKey, id: string) {
        const row = yield* sql`
          SELECT * FROM update_releases
          WHERE id = ${id} AND channel = ${key.channel} AND platform = ${key.platform}
            AND runtime_version = ${key.runtimeVersion}`.pipe(decodeFirst(ReleaseRow))
        return row === undefined ? Option.none() : Option.some(yield* toStored(row))
      })

      const append = Effect.fn("UpdateStore.append")(function* (key: RuntimeKey, stored: StoredRelease) {
        const [latest] = yield* releases(key, 1)
        // Clients take an update only if it's newer than the one they run, so each release must be later than the last.
        const createdAt =
          latest !== undefined && !DateTime.isGreaterThan(stored.release.createdAt, latest.release.createdAt)
            ? DateTime.add(latest.release.createdAt, { milliseconds: 1 })
            : stored.release.createdAt
        const release = { ...stored.release, createdAt } as UpdateRelease
        const update = release._tag === "Update" ? release : undefined
        const content = Option.match(stored.content, {
          onNone: () => null,
          onSome: (c) => Schema.encodeSync(contentCodec)(c)
        })
        yield* exec(sql`
          INSERT INTO update_releases
            (id, channel, platform, runtime_version, kind, created_at, content_json, git_commit, message, republish_of)
          VALUES (${release.id}, ${key.channel}, ${key.platform}, ${key.runtimeVersion},
            ${update === undefined ? "rollback_to_embedded" : "update"}, ${iso(createdAt)}, ${content},
            ${update?.gitCommit ?? null}, ${update?.message ?? null}, ${update?.republishOf ?? null})`)
        return { release, content: stored.content }
      })

      const checkIn = Effect.fn("UpdateStore.checkIn")(function* (key: RuntimeKey, at: UpdateCheckIn) {
        yield* exec(sql`
          INSERT INTO update_check_ins
            (channel, platform, runtime_version, last_check_at, running_update_id, embedded_update_id)
          VALUES (${key.channel}, ${key.platform}, ${key.runtimeVersion}, ${iso(at.lastCheckAt)},
            ${at.runningUpdateId ?? null}, ${at.embeddedUpdateId ?? null})
          ON CONFLICT (channel, platform, runtime_version) DO UPDATE SET last_check_at = excluded.last_check_at,
            running_update_id = excluded.running_update_id, embedded_update_id = excluded.embedded_update_id`)
      })

      const runtimes = Effect.fn("UpdateStore.runtimes")(function* (channel: UpdateChannel) {
        const released = yield* sql`
          SELECT runtime_version, platform, MAX(created_at) AS latest FROM update_releases WHERE channel = ${channel}
          GROUP BY runtime_version, platform`.pipe(
          decodeRows(Schema.Struct({ runtime_version: Schema.String, platform: Schema.String, latest: Schema.String }))
        )
        const checkIns = yield* sql`SELECT * FROM update_check_ins WHERE channel = ${channel}`.pipe(
          decodeRows(CheckInRow)
        )
        const byKey = new Map<
          string,
          { runtimeVersion: string; platform: string; at: string; checkIn?: UpdateCheckIn }
        >()
        for (const row of released)
          byKey.set(`${row.platform}/${row.runtime_version}`, {
            runtimeVersion: row.runtime_version,
            platform: row.platform,
            at: row.latest
          })
        for (const row of checkIns) {
          const id = `${row.platform}/${row.runtime_version}`
          const checkIn: UpdateCheckIn = {
            lastCheckAt: row.last_check_at,
            ...(row.running_update_id === null ? {} : { runningUpdateId: row.running_update_id }),
            ...(row.embedded_update_id === null ? {} : { embeddedUpdateId: row.embedded_update_id })
          }
          const existing = byKey.get(id)
          const at = iso(row.last_check_at)
          byKey.set(id, {
            runtimeVersion: row.runtime_version,
            platform: row.platform,
            at: existing !== undefined && existing.at > at ? existing.at : at,
            checkIn
          })
        }
        // Most recently active first.
        return [...byKey.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).map(({ at: _, ...rest }) => rest)
      })

      const keyRow = sql`SELECT * FROM update_signing_key WHERE name = ${keyName}`.pipe(decodeFirst(KeyRow))

      const signingKey = Effect.gen(function* () {
        const row = yield* keyRow
        if (row === undefined) return Option.none()
        const pkcs8 = yield* box
          .open(
            {
              keyVersion: row.key_version,
              wrappedKey: row.wrapped_key,
              keyNonce: row.key_nonce,
              nonce: row.nonce,
              ciphertext: row.ciphertext
            },
            keyAad
          )
          .pipe(Effect.orDie)
        return Option.some({ certificatePem: row.certificate_pem, key: yield* importSigningKey(pkcs8) })
      }).pipe(Effect.withSpan("UpdateStore.signingKey"))

      const certificate = Effect.map(keyRow, (row) => Option.fromUndefinedOr(row?.certificate_pem))

      const ensureSigningKey = Effect.gen(function* () {
        const existing = yield* keyRow
        if (existing !== undefined) return { certificatePem: existing.certificate_pem, created: false }
        const generated = yield* generateSigningKey("Dream updates")
        const sealed = yield* box.seal(generated.privateKeyPkcs8, keyAad)
        // Two concurrent requests both generate; the first insert wins and both answer with what's stored.
        yield* exec(sql`
          INSERT INTO update_signing_key
            (name, certificate_pem, key_version, wrapped_key, key_nonce, nonce, ciphertext, created_at)
          VALUES (${keyName}, ${generated.certificatePem}, ${sealed.keyVersion}, ${sealed.wrappedKey},
            ${sealed.keyNonce}, ${sealed.nonce}, ${sealed.ciphertext}, ${iso(yield* DateTime.now)})
          ON CONFLICT (name) DO NOTHING`)
        const stored = yield* keyRow
        if (stored === undefined) return yield* Effect.die("the signing key wasn't stored")
        return { certificatePem: stored.certificate_pem, created: stored.certificate_pem === generated.certificatePem }
      }).pipe(Effect.withSpan("UpdateStore.ensureSigningKey"))

      return UpdateStore.of({
        releases,
        release,
        append,
        checkIn,
        runtimes,
        signingKey,
        certificate,
        ensureSigningKey
      })
    })
  )
}
