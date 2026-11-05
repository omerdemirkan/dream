/**
 * `CreateConnectLink` and the token page it opens: the phone asks for a link,
 * the browser GETs the page and POSTs the token straight to the Worker, and the
 * stored connection is the one sandbox creation reads.
 */
import { assert, describe, it } from "@effect/vitest"
import { DaemonEnvFile, type UserId } from "@dream/domain"
import { DateTime, Effect, Layer, Redacted } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { route } from "../src/http/Router.ts"
import { utf8 } from "../src/lib/Bytes.ts"
import { importHmacKey, signHs256 } from "../src/lib/Jwt.ts"
import { makeCloud } from "./support/Cloud.ts"

const claudeToken = `sk-ant-oat01-${"y".repeat(80)}`

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

/** One request through the Worker's router, as a browser would send it. */
const browser = (cloud: Cloud, raw: Request) =>
  Effect.gen(function* () {
    const response = yield* route(raw).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
      Effect.provide(Layer.succeedContext(cloud.workerContext))
    )
    const web = HttpServerResponse.toWeb(response)
    return { status: web.status, headers: web.headers, body: yield* Effect.promise(() => web.text()) }
  })

const get = (cloud: Cloud, url: string) => browser(cloud, new Request(url))

const post = (cloud: Cloud, ticket: string, token: string) =>
  browser(
    cloud,
    new Request("https://api.dream.test/connect/claude", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: ticket, token }).toString()
    })
  )

const signIn = (cloud: Cloud) =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({ email: "omer@example.com", secret: Redacted.make("dev-secret") })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
    return signedIn.user
  })

const ticketOf = (url: string) => new URL(url).searchParams.get("t")!

describe("connect links", () => {
  it.live("stores a pasted Claude token as the connection sandboxes are created with", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      yield* signIn(cloud)
      const before = yield* DateTime.now
      const link = yield* cloud.phone.CreateConnectLink({ provider: "claude" })
      assert.match(link.url, /^https:\/\/api\.dream\.test\/connect\/claude\?t=[\w.-]+$/)
      const minutes = (DateTime.toEpochMillis(link.expiresAt) - DateTime.toEpochMillis(before)) / 60_000
      assert.isTrue(minutes > 14.9 && minutes <= 15.1)

      const page = yield* get(cloud, link.url)
      assert.strictEqual(page.status, 200)
      assert.strictEqual(page.headers.get("cache-control"), "no-store")
      assert.match(page.headers.get("content-security-policy")!, /default-src 'none'.*form-action 'self'/)
      assert.notInclude(page.body, "<script")
      assert.include(page.body, 'type="password"')
      assert.include(page.body, "claude setup-token")
      assert.include(page.body, "stored encrypted and never shown again")

      const done = yield* post(cloud, ticketOf(link.url), `  ${claudeToken}\n`)
      assert.strictEqual(done.status, 200)
      assert.include(done.body, "Claude is connected")
      assert.notInclude(done.body, claudeToken)
      assert.strictEqual(done.headers.get("cache-control"), "no-store")

      const [connection] = yield* cloud.phone.ListModelConnections()
      assert.strictEqual(connection?.provider, "claude")
      assert.strictEqual(connection?.status, "connected")
      assert.notInclude(JSON.stringify(cloud.db.prepare("SELECT * FROM secrets").all()), claudeToken)

      // Sandbox creation reads it like any other Claude connection.
      const project = yield* cloud.phone.CreateProject({ idea: "A habit tracker for my morning routine." })
      assert.strictEqual(project.harness, "claude-code")
      yield* cloud.alarm(project.id)
      const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === project.id)!
      assert.deepStrictEqual(sandbox.rules["api.anthropic.com"], [
        { transform: { headers: { Authorization: `Bearer ${claudeToken}` } } }
      ])
      assert.notInclude(sandbox.files.get(DaemonEnvFile)!, claudeToken)
      yield* cloud.close
    })
  )

  it.live("works once", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      yield* signIn(cloud)
      const link = yield* cloud.phone.CreateConnectLink({ provider: "claude" })
      assert.strictEqual((yield* post(cloud, ticketOf(link.url), claudeToken)).status, 200)

      const again = yield* post(cloud, ticketOf(link.url), `sk-ant-oat01-${"z".repeat(80)}`)
      assert.strictEqual(again.status, 410)
      assert.include(again.body, "already used")
      const reopened = yield* get(cloud, link.url)
      assert.strictEqual(reopened.status, 410)
      assert.notInclude(reopened.body, 'type="password"')
      assert.strictEqual((yield* cloud.phone.ListModelConnections()).length, 1)
      yield* cloud.close
    })
  )

  it.live("rejects expired and forged tickets", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const user = yield* signIn(cloud)
      const key = yield* importHmacKey(utf8("test-signing-key"))
      const claims = (exp: number, userId: UserId = user.id) => ({
        iss: "dream",
        typ: "connect",
        sub: userId,
        prv: "claude",
        jti: "ctk_expired",
        exp
      })
      const expired = yield* signHs256(key, claims(Math.floor(Date.now() / 1000) - 1))
      const page = yield* get(cloud, `https://api.dream.test/connect/claude?t=${expired}`)
      assert.strictEqual(page.status, 410)
      assert.include(page.body, "This link expired")
      assert.strictEqual((yield* post(cloud, expired, claudeToken)).status, 410)

      // Signed with the right key but never issued: there's no ticket row for it.
      const unissued = yield* signHs256(key, claims(Math.floor(Date.now() / 1000) + 600))
      assert.strictEqual((yield* post(cloud, unissued, claudeToken)).status, 410)

      const bogus = yield* get(cloud, "https://api.dream.test/connect/claude?t=bogus")
      assert.strictEqual(bogus.status, 404)
      assert.include(bogus.body, "This link isn't valid")
      assert.strictEqual((yield* get(cloud, "https://api.dream.test/connect/claude")).status, 404)
      assert.strictEqual((yield* cloud.phone.ListModelConnections()).length, 0)
      yield* cloud.close
    })
  )

  it.live("asks again, on the same link, for something that isn't a Claude token", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      yield* signIn(cloud)
      const link = yield* cloud.phone.CreateConnectLink({ provider: "claude" })
      const wrong = "sk-proj-NotAClaudeToken0123456789abcdef"
      const retry = yield* post(cloud, ticketOf(link.url), wrong)
      assert.strictEqual(retry.status, 400)
      assert.include(retry.body, "doesn&#39;t look like a Claude token")
      assert.notInclude(retry.body, wrong)
      assert.include(retry.body, 'type="password"')
      assert.strictEqual((yield* cloud.phone.ListModelConnections()).length, 0)

      assert.strictEqual((yield* post(cloud, ticketOf(link.url), claudeToken)).status, 200)
      assert.strictEqual((yield* cloud.phone.ListModelConnections())[0]?.status, "connected")
      yield* cloud.close
    })
  )
})
