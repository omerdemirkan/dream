/** POST /client-errors and GET /admin/client-errors: the app's crash reports, stored and read back, rate-limited. */
import { Routes, UserId } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Tokens } from "../src/auth/Tokens.ts"
import { clientErrorLimits } from "../src/http/ClientErrors.ts"
import { route } from "../src/http/Router.ts"
import { makeCloud } from "./support/Cloud.ts"

const api = "https://api.dream.test"
type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const send = (cloud: Cloud, path: string, init: RequestInit = {}) =>
  Effect.gen(function* () {
    const raw = new Request(`${api}${path}`, init)
    const response = yield* route(raw).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
      Effect.provide(Layer.succeedContext(cloud.workerContext))
    )
    const web = HttpServerResponse.toWeb(response)
    return { status: web.status, body: yield* Effect.promise(() => web.text()) }
  })

const report = {
  kind: "fatal",
  message: "TypeError: undefined is not a function",
  stack: "at ReplyPill (index.bundle:1:2)",
  screen: "/project/prj_liftlog",
  build: { version: "1.0.0", build: "26858598", updateId: "0193-abc", channel: "production", os: "ios 26.1" },
  occurredAt: "2026-11-08T19:00:00.000Z"
}

const post = (cloud: Cloud, body: unknown, headers: Record<string, string> = {}) =>
  send(cloud, Routes.clientErrors, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: JSON.stringify(body)
  })

describe("client error reports", () => {
  it.live("stores a report, with whose app it was when it comes with a session, for operators to read", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const token = yield* Effect.gen(function* () {
        const tokens = yield* Tokens
        return yield* tokens.session({ id: UserId.make("usr_founder"), email: "founder@example.com" })
      }).pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))

      assert.strictEqual((yield* post(cloud, { reports: [report] })).status, 204)
      const signed = yield* post(
        cloud,
        { reports: [{ ...report, kind: "render", componentStack: "in Thread" }] },
        { authorization: `Bearer ${Redacted.value(token)}` }
      )
      assert.strictEqual(signed.status, 204)

      assert.strictEqual((yield* send(cloud, Routes.clientErrorsAdmin)).status, 403)
      const read = yield* send(cloud, Routes.clientErrorsAdmin, { headers: { "x-dream-dev-secret": "dev-secret" } })
      assert.strictEqual(read.status, 200, read.body)
      const reports = JSON.parse(read.body).reports as Array<Record<string, unknown>>
      assert.strictEqual(reports.length, 2)
      const byKind = Object.fromEntries(reports.map((r) => [r.kind, r]))
      assert.deepInclude(byKind.fatal, {
        message: report.message,
        stack: report.stack,
        screen: report.screen,
        app_version: "1.0.0",
        app_build: "26858598",
        update_id: "0193-abc",
        channel: "production",
        os: "ios 26.1",
        occurred_at: report.occurredAt,
        user_id: null
      })
      assert.deepInclude(byKind.render, { component_stack: "in Thread", user_id: "usr_founder" })

      const fatalOnly = yield* send(cloud, `${Routes.clientErrorsAdmin}?kind=fatal`, {
        headers: { "x-dream-dev-secret": "dev-secret" }
      })
      assert.strictEqual(JSON.parse(fatalOnly.body).reports.length, 1)
    })
  )

  it.live("refuses a malformed report and stops counting an address past its limit", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      assert.strictEqual((yield* post(cloud, { reports: [{ ...report, kind: "oops" }] })).status, 400)
      assert.strictEqual((yield* post(cloud, { reports: [{ ...report, message: "x".repeat(5000) }] })).status, 400)
      for (let i = 2; i < clientErrorLimits.perAddress; i++)
        assert.strictEqual((yield* post(cloud, { reports: [report] })).status, 204)
      assert.strictEqual((yield* post(cloud, { reports: [report] })).status, 429)
      // Another address still gets through.
      assert.strictEqual(
        (yield* post(cloud, { reports: [report] }, { "cf-connecting-ip": "198.51.100.1" })).status,
        204
      )
    })
  )
})
