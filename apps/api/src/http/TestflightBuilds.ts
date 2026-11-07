/**
 * `Routes.testflightBuilds` (operator): the latest builds of Dream's app in App Store Connect, read by the Worker
 * with the TestFlight key it holds (`ASC_TESTFLIGHT_KEY_P8`), so checking on an upload doesn't take the one
 * Namespace Mac. The Worker signs a short-lived ES256 JWT with the key and calls three read-only endpoints; the
 * key and the JWT never leave it (not in a response, not in a log). App Store Connect's own error detail is passed
 * back, since it says what's wrong with the key (revoked, wrong issuer) and carries no secret.
 */
import {
  type TestflightAccountBuild,
  type TestflightBuild,
  type TestflightBuilds,
  UpstreamFailure
} from "@dream/domain"
import { Data, DateTime, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ApiConfig, required } from "../Config.ts"
import { RateLimits } from "../db/RateLimits.ts"
import { describe } from "../e2b/E2B.ts"
import { importEs256Pem, signEs256 } from "../lib/Jwt.ts"

export const AscApiUrl = "https://api.appstoreconnect.apple.com"

/** App Store Connect answered with an error (a refused token answers 401). */
export class AscRefused extends Data.TaggedError("AscRefused")<{ readonly status: number; readonly detail: string }> {}

/** The stored key doesn't import as a P-256 PKCS#8 key. */
export class AscKeyUnusable extends Data.TaggedError("AscKeyUnusable")<{ readonly reason: string }> {}

export class TestflightRateLimited extends Data.TaggedError("TestflightRateLimited")<{}> {}

/** At most this many reads per window: each is three App Store Connect calls, against the key's hourly quota. */
export const buildsRateLimit = { limit: 6, windowMs: 60_000 }
const jwtLifetimeSec = 5 * 60
const listLimit = 5

/** The App Store Connect API token for the TestFlight key: ES256, `kid` the key id, 5 minutes. */
export const mintAscJwt = (pem: string, keyId: string, issuerId: string, nowMs: number) =>
  Effect.gen(function* () {
    const key = yield* importEs256Pem(pem).pipe(Effect.mapError((e) => new AscKeyUnusable({ reason: e.reason })))
    const iat = Math.floor(nowMs / 1000)
    return yield* signEs256(
      key,
      { kid: keyId, typ: "JWT" },
      { iss: issuerId, iat, exp: iat + jwtLifetimeSec, aud: "appstoreconnect-v1" }
    )
  })

const ErrorBody = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({ title: Schema.optionalKey(Schema.String), detail: Schema.optionalKey(Schema.String) })
  )
})

const Apps = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, attributes: Schema.Struct({ name: Schema.String, bundleId: Schema.String }) })
  )
})

const Related = Schema.optionalKey(
  Schema.Struct({ data: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.String }))) })
)

const Builds = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      attributes: Schema.Struct({
        version: Schema.String,
        uploadedDate: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString)),
        processingState: Schema.String,
        expired: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
      }),
      relationships: Schema.optionalKey(Schema.Struct({ buildBetaDetail: Related, app: Related }))
    })
  ),
  included: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.String,
        attributes: Schema.optionalKey(
          Schema.Struct({
            internalBuildState: Schema.optionalKey(Schema.NullOr(Schema.String)),
            externalBuildState: Schema.optionalKey(Schema.NullOr(Schema.String)),
            bundleId: Schema.optionalKey(Schema.NullOr(Schema.String))
          })
        )
      })
    )
  )
})
type Builds = typeof Builds.Type

const present = <K extends string, A>(key: K, value: A | null | undefined): { [P in K]?: A } =>
  (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: A }

const included = (page: Builds, type: string, id: string | undefined) =>
  page.included?.find((r) => r.type === type && r.id === id)?.attributes

/** GETs `path` on App Store Connect with `jwt` and decodes the body with `schema`. */
const ascGet = <S extends Schema.Codec<any, any, never, never>>(path: string, jwt: string, schema: S) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* HttpClientRequest.get(`${AscApiUrl}${path}`).pipe(
      HttpClientRequest.bearerToken(jwt),
      http.execute,
      Effect.mapError(
        (cause) => new UpstreamFailure({ service: "App Store Connect", message: `unreachable: ${describe(cause)}` })
      )
    )
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)), Effect.option)
      const first = Option.flatMap(body, (b) => Option.fromUndefinedOr(b.errors[0]))
      const detail = Option.match(first, { onNone: () => "", onSome: (e) => e.detail ?? e.title ?? "" })
      return yield* new AscRefused({ status: response.status, detail })
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(
        () =>
          new UpstreamFailure({ service: "App Store Connect", message: `unexpected answer from ${path.split("?")[0]}` })
      )
    )
  })

/** Reads the builds; fails with `TestflightRateLimited` past `buildsRateLimit`. */
export const readTestflightBuilds = Effect.fn("TestflightBuilds.read")(function* (bundleId?: string) {
  const config = yield* ApiConfig
  const limits = yield* RateLimits
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
  if (!(yield* limits.hit("testflight-builds", buildsRateLimit.limit, buildsRateLimit.windowMs, nowMs)))
    return yield* new TestflightRateLimited()
  const pem = yield* required(config.ascTestflightKey, "App Store Connect", "ASC_TESTFLIGHT_KEY_P8")
  const jwt = yield* mintAscJwt(Redacted.value(pem), config.ascTestflightKeyId, config.ascTestflightIssuerId, nowMs)
  const bundle = bundleId ?? config.ascTestflightBundleId

  const [apps, account] = yield* Effect.all(
    [
      ascGet(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundle)}&fields[apps]=name,bundleId`, jwt, Apps),
      // Builds anywhere on the account: an upload under another bundle id lands on another app.
      ascGet(
        `/v1/builds?sort=-uploadedDate&limit=${listLimit}&fields[builds]=version,processingState,uploadedDate,app` +
          "&include=app&fields[apps]=bundleId",
        jwt,
        Builds
      )
    ],
    { concurrency: 2 }
  )
  const accountBuilds = account.data.map(
    (b): TestflightAccountBuild => ({
      build: b.attributes.version,
      processing: b.attributes.processingState,
      ...present("uploadedAt", b.attributes.uploadedDate),
      ...present("bundleId", included(account, "apps", b.relationships?.app?.data?.id ?? undefined)?.bundleId)
    })
  )
  // Apple matches `filter[bundleId]` by prefix too (`build.omer.dream.widget`), so pick the exact record.
  const app = apps.data.find((a) => a.attributes.bundleId === bundle)
  if (app === undefined) return { builds: [], accountBuilds } satisfies TestflightBuilds

  const page = yield* ascGet(
    `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=${listLimit}` +
      "&fields[builds]=version,processingState,expired,uploadedDate,buildBetaDetail" +
      "&include=buildBetaDetail&fields[buildBetaDetails]=internalBuildState,externalBuildState",
    jwt,
    Builds
  )
  const builds = page.data.map((b): TestflightBuild => {
    const beta = included(page, "buildBetaDetails", b.relationships?.buildBetaDetail?.data?.id ?? undefined)
    return {
      build: b.attributes.version,
      processing: b.attributes.processingState,
      expired: b.attributes.expired ?? false,
      ...present("uploadedAt", b.attributes.uploadedDate),
      ...present("internalState", beta?.internalBuildState),
      ...present("externalState", beta?.externalBuildState)
    }
  })
  yield* Effect.logInfo("read the TestFlight builds", { bundleId: bundle, builds: builds.length })
  return {
    app: { id: app.id, name: app.attributes.name, bundleId: app.attributes.bundleId },
    builds,
    accountBuilds
  } satisfies TestflightBuilds
})
