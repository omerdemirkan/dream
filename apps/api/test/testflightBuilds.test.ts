/**
 * Reading Dream's TestFlight builds on the Worker: the App Store Connect JWT it signs (header, claims, and a
 * signature that verifies with the key's public half), the three read-only calls against a fake App Store
 * Connect, the operator check, App Store Connect's refusals, and the rate limit.
 */
import { Routes, TestflightBuilds } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { D1Client } from "@effect/sql-d1"
import { RateLimits } from "../src/db/RateLimits.ts"
import { route } from "../src/http/Router.ts"
import { buildsRateLimit } from "../src/http/TestflightBuilds.ts"
import { fromBase64Url, fromUtf8, toBase64, utf8, type WebCryptoKey } from "../src/lib/Bytes.ts"
import { makeCloud } from "./support/Cloud.ts"
import { makeD1 } from "./support/Sqlite.ts"

const subtle = crypto.subtle as any
const api = "https://api.dream.test"
const keyId = "TESTKEY123"
const issuerId = "00000000-0000-0000-0000-000000000000"

/** A fresh P-256 key as App Store Connect hands it out (PKCS#8 PEM), and its public half. */
const ascKey = Effect.promise(async () => {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey))
  const body = toBase64(pkcs8).replace(/(.{64})/g, "$1\n")
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey as WebCryptoKey
  }
})

interface Seen {
  readonly url: URL
  readonly jwt: string
}

/** App Store Connect for one app with two builds, plus a build of another app on the account. */
const fakeAsc = (seen: Array<Seen>, answer?: (url: URL) => Response | undefined) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assert.strictEqual(url.origin, "https://api.appstoreconnect.apple.com")
    seen.push({ url, jwt: (request.headers.get("authorization") ?? "").replace(/^Bearer /, "") })
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    const special = answer?.(url)
    if (special !== undefined) return special
    const q = url.searchParams
    if (url.pathname === "/v1/apps") {
      const apps = [
        { type: "apps", id: "66", attributes: { name: "Dream (widget)", bundleId: "build.omer.dream.widget" } },
        { type: "apps", id: "65", attributes: { name: "Dream by Omer", bundleId: "build.omer.dream" } }
      ]
      return json({ data: apps.filter((a) => a.attributes.bundleId.startsWith(q.get("filter[bundleId]") ?? "?")) })
    }
    if (url.pathname === "/v1/builds" && q.get("filter[app]") === "65") {
      assert.strictEqual(q.get("include"), "buildBetaDetail")
      return json({
        data: [
          {
            type: "builds",
            id: "b2",
            attributes: {
              version: "42",
              uploadedDate: "2026-11-07T09:30:00.000-08:00",
              processingState: "PROCESSING",
              expired: false
            },
            relationships: { buildBetaDetail: { data: { type: "buildBetaDetails", id: "d2" } } }
          },
          {
            type: "builds",
            id: "b1",
            attributes: {
              version: "41",
              uploadedDate: "2026-11-01T10:00:00.000-07:00",
              processingState: "VALID",
              expired: true
            },
            relationships: { buildBetaDetail: { data: { type: "buildBetaDetails", id: "d1" } } }
          }
        ],
        included: [
          {
            type: "buildBetaDetails",
            id: "d1",
            attributes: { internalBuildState: "EXPIRED", externalBuildState: "EXPIRED" }
          },
          {
            type: "buildBetaDetails",
            id: "d2",
            attributes: { internalBuildState: "PROCESSING", externalBuildState: "PROCESSING" }
          }
        ]
      })
    }
    if (url.pathname === "/v1/builds" && !q.has("filter[app]")) {
      assert.strictEqual(q.get("include"), "app")
      return json({
        data: [
          {
            type: "builds",
            id: "x1",
            attributes: { version: "7", uploadedDate: "2026-11-07T18:00:00Z", processingState: "INVALID" },
            relationships: { app: { data: { type: "apps", id: "99" } } }
          },
          {
            type: "builds",
            id: "b2",
            attributes: { version: "42", uploadedDate: "2026-11-07T17:30:00Z", processingState: "PROCESSING" },
            relationships: { app: { data: { type: "apps", id: "65" } } }
          }
        ],
        included: [
          { type: "apps", id: "99", attributes: { bundleId: "build.omer.other" } },
          { type: "apps", id: "65", attributes: { bundleId: "build.omer.dream" } }
        ]
      })
    }
    return new Response("not found", { status: 404 })
  }) as typeof globalThis.fetch

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const send = (cloud: Cloud, fetch: typeof globalThis.fetch, path: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const raw = new Request(`${api}${path}`, { headers })
    const response = yield* route(raw).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provide(Layer.succeedContext(cloud.workerContext))
    )
    const web = HttpServerResponse.toWeb(response)
    return { status: web.status, body: yield* Effect.promise(() => web.text()) }
  })

const operator = { "x-dream-dev-secret": "dev-secret" }

const segment = (part: string) => JSON.parse(fromUtf8(fromBase64Url(part)))

describe("GET /admin/testflight/builds", () => {
  it.live("signs its own App Store Connect JWT and returns the latest builds", () =>
    Effect.gen(function* () {
      const key = yield* ascKey
      const cloud = yield* makeCloud({ ascTestflightKey: Option.some(Redacted.make(key.pem)) })
      const seen: Array<Seen> = []
      const before = Math.floor(Date.now() / 1000)
      const response = yield* send(cloud, fakeAsc(seen), Routes.testflightBuilds, operator)
      assert.strictEqual(response.status, 200, response.body)
      const builds = Schema.decodeUnknownSync(Schema.toCodecJson(TestflightBuilds))(JSON.parse(response.body))
      assert.deepStrictEqual(builds.app, { id: "65", name: "Dream by Omer", bundleId: "build.omer.dream" })
      assert.deepStrictEqual(JSON.parse(response.body).builds, [
        {
          build: "42",
          uploadedAt: "2026-11-07T17:30:00.000Z",
          processing: "PROCESSING",
          expired: false,
          internalState: "PROCESSING",
          externalState: "PROCESSING"
        },
        {
          build: "41",
          uploadedAt: "2026-11-01T17:00:00.000Z",
          processing: "VALID",
          expired: true,
          internalState: "EXPIRED",
          externalState: "EXPIRED"
        }
      ])
      assert.deepStrictEqual(
        builds.accountBuilds.map((b) => [b.build, b.processing, b.bundleId]),
        [
          ["7", "INVALID", "build.omer.other"],
          ["42", "PROCESSING", "build.omer.dream"]
        ]
      )

      // Three calls, all with one JWT: ES256, the key's id, App Store Connect's audience, five minutes.
      assert.strictEqual(seen.length, 3)
      const jwt = seen[0]!.jwt
      assert.isTrue(seen.every((s) => s.jwt === jwt))
      const [header, claims, signature] = jwt.split(".") as [string, string, string]
      assert.deepStrictEqual(segment(header), { alg: "ES256", kid: keyId, typ: "JWT" })
      const payload = segment(claims)
      assert.deepStrictEqual(Object.keys(payload).sort(), ["aud", "exp", "iat", "iss"])
      assert.strictEqual(payload.iss, issuerId)
      assert.strictEqual(payload.aud, "appstoreconnect-v1")
      assert.isTrue(payload.iat >= before && payload.iat <= Math.floor(Date.now() / 1000))
      assert.strictEqual(payload.exp - payload.iat, 300)
      const verified = yield* Effect.promise(() =>
        subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key.publicKey,
          fromBase64Url(signature),
          utf8(`${header}.${claims}`)
        )
      )
      assert.isTrue(verified)

      // Nothing of the key, nor the token, in the response.
      assert.notInclude(response.body, jwt)
      assert.notInclude(response.body, key.pem.split("\n")[1]!)
    })
  )

  it.live("is only for the operator, and checks the bundle id", () =>
    Effect.gen(function* () {
      const key = yield* ascKey
      const cloud = yield* makeCloud({ ascTestflightKey: Option.some(Redacted.make(key.pem)) })
      const seen: Array<Seen> = []
      for (const headers of [{}, { "x-dream-dev-secret": "wrong" }]) {
        const response = yield* send(cloud, fakeAsc(seen), Routes.testflightBuilds, headers)
        assert.strictEqual(response.status, 403)
      }
      const bad = yield* send(cloud, fakeAsc(seen), `${Routes.testflightBuilds}?bundleId=a%26b`, operator)
      assert.strictEqual(bad.status, 400)
      assert.strictEqual(seen.length, 0)

      // No app record for the bundle id: no app, no app builds, the account's builds still.
      const other = yield* send(cloud, fakeAsc(seen), `${Routes.testflightBuilds}?bundleId=build.omer.none`, operator)
      assert.strictEqual(other.status, 200)
      const body = JSON.parse(other.body)
      assert.strictEqual(body.app, undefined)
      assert.deepStrictEqual(body.builds, [])
      assert.strictEqual(body.accountBuilds.length, 2)
    })
  )

  it.live("passes on App Store Connect's refusal, and says when the key is missing or broken", () =>
    Effect.gen(function* () {
      const key = yield* ascKey
      const refusing = fakeAsc(
        [],
        () =>
          new Response(
            JSON.stringify({
              errors: [
                {
                  status: "401",
                  code: "NOT_AUTHORIZED",
                  title: "Authentication credentials are missing or invalid.",
                  detail: "Provide a properly configured and signed bearer token."
                }
              ]
            }),
            { status: 401, headers: { "content-type": "application/json" } }
          )
      )
      const cloud = yield* makeCloud({ ascTestflightKey: Option.some(Redacted.make(key.pem)) })
      const refused = yield* send(cloud, refusing, Routes.testflightBuilds, operator)
      assert.strictEqual(refused.status, 502)
      assert.deepStrictEqual(JSON.parse(refused.body), {
        appStoreConnect: 401,
        problem: "Provide a properly configured and signed bearer token."
      })

      const unset = yield* makeCloud({ ascTestflightKey: Option.none() })
      const missing = yield* send(unset, fakeAsc([]), Routes.testflightBuilds, operator)
      assert.strictEqual(missing.status, 503)
      assert.include(JSON.parse(missing.body).problem, "ASC_TESTFLIGHT_KEY_P8")

      const broken = yield* makeCloud({
        ascTestflightKey: Option.some(
          Redacted.make("-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----")
        )
      })
      const unusable = yield* send(broken, fakeAsc([]), Routes.testflightBuilds, operator)
      assert.strictEqual(unusable.status, 500)
      assert.include(JSON.parse(unusable.body).problem, "doesn't import")
      assert.notInclude(unusable.body, "bm90IGEga2V5")
    })
  )

  it.live("allows a few reads a minute", () =>
    Effect.gen(function* () {
      const key = yield* ascKey
      const cloud = yield* makeCloud({ ascTestflightKey: Option.some(Redacted.make(key.pem)) })
      const seen: Array<Seen> = []
      for (let i = 0; i < buildsRateLimit.limit; i++)
        assert.strictEqual((yield* send(cloud, fakeAsc(seen), Routes.testflightBuilds, operator)).status, 200)
      const limited = yield* send(cloud, fakeAsc(seen), Routes.testflightBuilds, operator)
      assert.strictEqual(limited.status, 429)
      assert.strictEqual(seen.length, buildsRateLimit.limit * 3)
    })
  )
})

describe("RateLimits", () => {
  it.effect("counts hits per key in fixed windows", () =>
    Effect.gen(function* () {
      const limits = yield* RateLimits
      const hits = (key: string, nowMs: number, n: number) =>
        Effect.forEach(Array.from({ length: n }), () => limits.hit(key, 2, 60_000, nowMs))
      assert.deepStrictEqual(yield* hits("a", 1_000, 3), [true, true, false])
      assert.deepStrictEqual(yield* hits("b", 1_000, 1), [true])
      assert.deepStrictEqual(yield* hits("a", 60_999, 1), [false])
      assert.deepStrictEqual(yield* hits("a", 61_000, 3), [true, true, false])
    }).pipe(Effect.provide(RateLimits.layer.pipe(Layer.provide(D1Client.layer({ db: makeD1().d1 }).pipe(Layer.orDie)))))
  )
})
