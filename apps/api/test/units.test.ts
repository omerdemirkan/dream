/**
 * The pieces with sharp edges: crypto, token formats, CLI output scraping,
 * envelope framing, cron and ranges.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted, Stream } from "effect"
import { Tokens } from "../src/auth/Tokens.ts"
import { ApiConfig } from "../src/Config.ts"
import { findClaudeToken, findClaudeUrl, findDeviceCode, stripAnsi } from "../src/connect/ModelConnect.ts"
import { slugFromIdea, titleFromIdea } from "../src/db/Projects.ts"
import { decodeEnvelopes, encodeEnvelope } from "../src/e2b/Envd.ts"
import { portNotOpen, waking } from "../src/http/Gateway.ts"
import { parseRange } from "../src/http/Media.ts"
import { keyPlaceholder } from "../src/integrations/Access.ts"
import { mintAppleJwt } from "../src/integrations/CredentialStore.ts"
import { type KeyFile, leakedKey } from "../src/integrations/KeyFiles.ts"
import { hostsForScopes, labelForScopes, scopeUrl } from "../src/integrations/Google.ts"
import { fromBase64Url, fromUtf8, toBase64, type WebCryptoKey } from "../src/lib/Bytes.ts"
import { decodeUnverified, importEs256Pem, signEs256 } from "../src/lib/Jwt.ts"
import { makeSecretBox } from "../src/lib/SecretBox.ts"
import { nextWakeAt } from "../src/project/Handlers.ts"
import { notificationText } from "../src/project/Notifier.ts"
import { backoffMs, daemonSettings } from "../src/project/SandboxManager.ts"

const masterKey = "11".repeat(32)

const p8 = Effect.promise(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" } as any, true, [
    "sign",
    "verify"
  ])) as unknown as { privateKey: WebCryptoKey; publicKey: WebCryptoKey }
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer)
  const body = toBase64(pkcs8)
    .match(/.{1,64}/g)!
    .join("\n")
  return { pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey }
})

describe("SecretBox", () => {
  it.effect("round-trips and binds the ciphertext to its row", () =>
    Effect.gen(function* () {
      const box = yield* makeSecretBox(masterKey)
      const sealed = yield* box.seal('{"token":"sk-ant-oat01-secret"}', "row-1")
      assert.notInclude(JSON.stringify(sealed), "sk-ant")
      assert.strictEqual(yield* box.open(sealed, "row-1"), '{"token":"sk-ant-oat01-secret"}')
      const moved = yield* Effect.flip(box.open(sealed, "row-2"))
      assert.strictEqual(moved._tag, "SecretBoxError")
      const other = yield* makeSecretBox("22".repeat(32))
      assert.strictEqual((yield* Effect.flip(other.open(sealed, "row-1")))._tag, "SecretBoxError")
    })
  )

  it.effect("rejects a key that isn't 32 bytes", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* Effect.flip(makeSecretBox("abcd")))._tag, "SecretBoxError")
    })
  )
})

describe("Tokens", () => {
  const layer = Tokens.layer.pipe(Layer.provide(ApiConfig.layerTest()))
  it.effect("issues and checks sessions, project tokens and tickets, each only for its use", () =>
    Effect.gen(function* () {
      const tokens = yield* Tokens
      const session = Redacted.value(yield* tokens.session({ id: "usr_1" as any, email: "a@b.c" }))
      assert.strictEqual((yield* tokens.verifySession(session)).userId, "usr_1")
      const project = Redacted.value(yield* tokens.project("prj_1" as any, "usr_1" as any))
      assert.strictEqual((yield* tokens.verifyProject(project)).projectId, "prj_1")
      assert.strictEqual((yield* Effect.flip(tokens.verifySession(project)))._tag, "InvalidToken")
      assert.strictEqual((yield* Effect.flip(tokens.verifyProject(session)))._tag, "InvalidToken")
      const ticket = yield* tokens.liveTicket("prj_1" as any, "usr_1" as any)
      assert.strictEqual((yield* tokens.verifyLiveTicket(ticket)).projectId, "prj_1")
      const tampered = `${session.slice(0, -2)}xx`
      assert.strictEqual((yield* Effect.flip(tokens.verifySession(tampered)))._tag, "InvalidToken")
    }).pipe(Effect.provide(layer))
  )
})

describe("ES256", () => {
  it.effect("signs JWTs a P-256 public key verifies (APNs, App Store Connect)", () =>
    Effect.gen(function* () {
      const { pem, publicKey } = yield* p8
      const key = yield* importEs256Pem(pem)
      const jwt = yield* signEs256(key, { kid: "ABC123" }, { iss: "TEAM", iat: 1 })
      const decoded = yield* decodeUnverified(jwt)
      assert.deepStrictEqual(decoded.header, { alg: "ES256", kid: "ABC123" })
      const valid = yield* Effect.promise(() =>
        crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          publicKey,
          decoded.signature,
          new TextEncoder().encode(decoded.signingInput)
        )
      )
      assert.isTrue(valid)
      const apple = yield* mintAppleJwt({ issuerId: "issuer", keyId: "KEY", privateKey: pem }, 1_700_000_000_000)
      const claims = JSON.parse(fromUtf8(fromBase64Url(apple.jwt.split(".")[1]!)))
      assert.deepStrictEqual(claims, {
        iss: "issuer",
        iat: 1_700_000_000,
        exp: 1_700_001_140,
        aud: "appstoreconnect-v1"
      })
      assert.strictEqual((yield* Effect.flip(importEs256Pem("not a key")))._tag, "JwtError")
    })
  )
})

describe("CLI output", () => {
  const url =
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abc&code_challenge_method=S256&state=def"

  it("finds the setup-token URL in an OSC 8 hyperlink, even when the text wraps", () => {
    const screen = `Browser didn't open? Use the url below to sign in (c to copy)\r\n\u001b]8;id=s8se6m;${url}\u0007${url.slice(0, 60)}\u001b]8;;\u0007\r\n\u001b]8;id=s8se6m;${url}\u0007${url.slice(60)}\u001b]8;;\u0007\r\n`
    assert.deepStrictEqual(findClaudeUrl(screen), Option.some(url))
  })

  it("finds the URL in plain wrapped text", () => {
    assert.deepStrictEqual(
      findClaudeUrl(`\u001b[1m${url.slice(0, 50)}\r\n${url.slice(50)}\u001b[0m\r\n`),
      Option.some(url)
    )
  })

  it("finds the token after the code is pasted", () => {
    const token = `sk-ant-oat01-${"A1b2_C3-".repeat(12)}`
    assert.deepStrictEqual(
      findClaudeToken(`Your OAuth token (valid for 1 year):\r\n\u001b[33m${token}\u001b[0m\r\n`),
      Option.some(token)
    )
    assert.isTrue(Option.isNone(findClaudeToken("Paste code here if prompted > ")))
  })

  it("finds Codex's device code", () => {
    const out =
      "\nWelcome to Codex [v\u001b[90m0.166.0\u001b[0m]\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94m054Q-3BC5A\u001b[0m\n"
    assert.deepStrictEqual(
      findDeviceCode(out),
      Option.some({ url: "https://auth.openai.com/codex/device", code: "054Q-3BC5A" })
    )
    assert.strictEqual(stripAnsi("\u001b[94mhi\u001b[0m"), "hi")
  })
})

describe("Connect envelopes", () => {
  it.effect("reassembles messages split across chunks", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([...encodeEnvelope({ a: 1 }), ...encodeEnvelope({ b: "two" })])
      const chunks = [bytes.slice(0, 3), bytes.slice(3, 9), bytes.slice(9)]
      const messages = yield* Stream.runCollect(decodeEnvelopes(Stream.fromIterable(chunks)))
      assert.deepStrictEqual(messages, [
        [0, '{"a":1}'],
        [0, '{"b":"two"}']
      ])
    })
  )
})

describe("small rules", () => {
  it("gives each harness only its own model override, and the effort override to both", () => {
    const base = {
      apiUrl: "https://api.dream.test",
      projectId: "prj_1" as any,
      daemonToken: "t",
      agentModel: Option.some("haiku"),
      codexAgentModel: Option.some("gpt-6-luna"),
      agentEffort: Option.none()
    }
    assert.strictEqual(daemonSettings({ ...base, harness: "claude-code" }).DREAM_MODEL, "haiku")
    assert.strictEqual(daemonSettings({ ...base, harness: "codex" }).DREAM_MODEL, "gpt-6-luna")
    assert.notProperty(daemonSettings({ ...base, harness: "codex", codexAgentModel: Option.none() }), "DREAM_MODEL")
    assert.notProperty(daemonSettings({ ...base, harness: "claude-code", agentModel: Option.none() }), "DREAM_MODEL")
    assert.notProperty(daemonSettings({ ...base, harness: "claude-code" }), "DREAM_EFFORT")
    for (const harness of ["claude-code", "codex"] as const) {
      assert.strictEqual(daemonSettings({ ...base, harness, agentEffort: Option.some("low") }).DREAM_EFFORT, "low")
    }
  })

  it("slugs ideas into short DNS-safe names", () => {
    assert.strictEqual(
      slugFromIdea("A strength log that reads Apple Health and tells me when to add weight."),
      "strength-log-reads"
    )
    assert.strictEqual(slugFromIdea("A booking site for our family cabin"), "booking-site-family")
    assert.strictEqual(slugFromIdea("!!!"), "app")
  })

  it("titles ideas provisionally, in a few sentence-case words", () => {
    assert.strictEqual(
      titleFromIdea("A strength log that reads Apple Health and tells me when to add weight."),
      "Strength log"
    )
    assert.strictEqual(titleFromIdea("A booking site for our family cabin"), "Booking site for our family cabin")
    assert.strictEqual(titleFromIdea("I want you to build me an app that tracks my runs with Strava"), "Tracks my runs")
    assert.strictEqual(titleFromIdea("a recipe app for my mom!"), "Recipe app for my mom")
    assert.strictEqual(titleFromIdea("build an iOS app for my book club, with voting"), "iOS app for my book club")
    assert.strictEqual(titleFromIdea("Un journal de rêves"), "Un journal de rêves")
    assert.strictEqual(titleFromIdea("!!!"), "Untitled idea")
  })

  it("maps Google scopes to URLs, hosts and labels", () => {
    assert.strictEqual(scopeUrl("gmail.readonly"), "https://www.googleapis.com/auth/gmail.readonly")
    assert.deepStrictEqual(hostsForScopes(["gmail.readonly", "spreadsheets"]), [
      "gmail.googleapis.com",
      "sheets.googleapis.com",
      "www.googleapis.com"
    ])
    assert.strictEqual(labelForScopes(["gmail.readonly"]), "Gmail")
    assert.strictEqual(labelForScopes(["gmail.readonly", "calendar"]), "Google (Gmail, Calendar)")
  })

  it("names key placeholders after the service", () => {
    assert.strictEqual(keyPlaceholder("Stripe"), "dream-stripe-key")
    assert.strictEqual(keyPlaceholder("Open AI (prod)"), "dream-open-ai-prod-key")
  })

  it("computes cron wakes in their time zone", () => {
    const from = Date.parse("2026-11-05T12:00:00Z")
    const next = nextWakeAt({ _tag: "Cron", expression: "0 7 * * *" }, "America/Los_Angeles", from)
    assert.deepStrictEqual(next, Option.some(Date.parse("2026-11-05T15:00:00Z")))
    assert.isTrue(Option.isNone(nextWakeAt({ _tag: "Cron", expression: "nope" }, "UTC", from)))
  })

  it("parses byte ranges for video playback", () => {
    assert.deepStrictEqual(parseRange("bytes=0-1", 10), Option.some({ offset: 0, length: 2 }))
    assert.deepStrictEqual(parseRange("bytes=5-", 10), Option.some({ offset: 5, length: 5 }))
    assert.deepStrictEqual(parseRange("bytes=-3", 10), Option.some({ offset: 7, length: 3 }))
    assert.isTrue(Option.isNone(parseRange("bytes=20-30", 10)))
    assert.isTrue(Option.isNone(parseRange(undefined, 10)))
  })

  it("turns markdown into a short notification body", () => {
    assert.strictEqual(
      notificationText("**Done.** See [the app](https://x.y)\n\n```js\ncode\n```"),
      "Done. See the app"
    )
    assert.strictEqual(notificationText("a".repeat(300)).length, 178)
  })

  it("backs off delivery retries up to 15 minutes", () => {
    assert.deepStrictEqual([1, 2, 3, 4, 10].map(backoffMs), [5_000, 15_000, 45_000, 135_000, 900_000])
  })
})

describe("leakedKey", () => {
  const key = (value: string): KeyFile => ({
    row: {} as KeyFile["row"],
    service: "SMTP",
    name: "smtp",
    path: "/p",
    value
  })

  it("finds a key anywhere in a payload, even one JSON escapes", () => {
    const quoted = key('FAKE"pass\\word')
    assert.strictEqual(leakedKey({ text: `the password is ${quoted.value}!` }, [quoted]), quoted)
    assert.strictEqual(
      leakedKey({ milestones: [{ needs: [{ what: "FAKE-abcdef" }] }] }, [key("FAKE-abcdef")])?.value,
      "FAKE-abcdef"
    )
    assert.isUndefined(leakedKey({ text: "nothing secret here" }, [key("FAKE-abcdef")]))
  })

  it("ignores values too short to tell from ordinary text", () => {
    assert.isUndefined(leakedKey({ text: "abc" }, [key("abc")]))
  })
})

describe("the gateway while the app wakes", () => {
  const bodyText = (response: ReturnType<typeof waking>) =>
    response.body._tag === "Uint8Array" ? new TextDecoder().decode(response.body.body) : ""

  it("gives a browser a page that retries, and anything else a 503 to retry", () => {
    const page = waking(new Request("https://app.test/", { headers: { accept: "text/html,application/xhtml+xml" } }))
    assert.strictEqual(page.status, 503)
    assert.include(page.headers["content-type"] ?? "", "text/html")
    assert.include(bodyText(page), "location.reload()")

    for (const request of [
      new Request("https://app.test/api/items", { headers: { accept: "application/json" } }),
      new Request("https://app.test/", { method: "POST", headers: { accept: "text/html" }, body: "a=1" }),
      new Request("https://app.test/socket", { headers: { upgrade: "websocket" } })
    ]) {
      const response = waking(request)
      assert.strictEqual(response.status, 503)
      assert.strictEqual(response.headers["retry-after"], "2")
      assert.notInclude(response.headers["content-type"] ?? "", "text/html")
    }
  })

  it.effect("tells E2B's closed-port 502 from the app's own", () =>
    Effect.gen(function* () {
      const e2b = new Response(
        JSON.stringify({ message: "The sandbox is running but port is not open", sandboxId: "sbx", port: 3000 }),
        { status: 502, headers: { "content-type": "application/json" } }
      )
      assert.isTrue(yield* portNotOpen(e2b))
      const app = new Response("<h1>Bad gateway</h1>", { status: 502, headers: { "content-type": "text/html" } })
      assert.isFalse(yield* portNotOpen(app))
      assert.strictEqual(yield* Effect.promise(() => app.text()), "<h1>Bad gateway</h1>")
      assert.isFalse(yield* portNotOpen(new Response("ok")))
    })
  )
})
