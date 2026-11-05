/**
 * The public home and privacy pages on the API host, which Google's consent
 * screen links to, and that the routes around them still answer as before.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { route } from "../src/http/Router.ts"
import { makeCloud } from "./support/Cloud.ts"

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const fetchPage = (cloud: Cloud, url: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const raw = new Request(url, init)
    const response = yield* route(raw).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
      Effect.provide(Layer.succeedContext(cloud.workerContext))
    )
    const web = HttpServerResponse.toWeb(response)
    return { status: web.status, headers: web.headers, body: yield* Effect.promise(() => web.text()) }
  })

describe("public pages", () => {
  it.live("serves the home page and the privacy policy as self-contained HTML", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const home = yield* fetchPage(cloud, "https://api.dream.test/")
      assert.strictEqual(home.status, 200)
      assert.match(home.headers.get("content-type")!, /^text\/html/)
      assert.include(home.body, "iPhone app")
      assert.include(home.body, 'href="/privacy"')

      const privacy = yield* fetchPage(cloud, "https://api.dream.test/privacy/")
      assert.strictEqual(privacy.status, 200)
      assert.include(privacy.body, "Limited Use requirements")
      assert.include(privacy.body, "AES-GCM")
      assert.include(privacy.body, "mailto:omerfarukpiano@gmail.com")
      assert.include(privacy.headers.get("content-security-policy")!, "default-src 'none'")
      for (const page of [home.body, privacy.body]) {
        assert.notMatch(page, /<script|<link|<img|src=|url\(/i)
        assert.include(page, 'name="viewport"')
      }
    })
  )

  it.live("leaves other paths, methods and hosts alone", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      assert.strictEqual((yield* fetchPage(cloud, "https://api.dream.test/health")).body, "ok")
      assert.strictEqual((yield* fetchPage(cloud, "https://api.dream.test/nope")).status, 404)
      assert.strictEqual((yield* fetchPage(cloud, "https://api.dream.test/", { method: "POST" })).status, 404)
      assert.strictEqual((yield* fetchPage(cloud, "https://api.dream.test/media/med_x")).status, 401)
      assert.notInclude((yield* fetchPage(cloud, "https://nothing-here.dream.test/privacy")).body, "Privacy policy")
    })
  )
})
