import { assert, describe, it } from "@effect/vitest"
import { dreamSkill } from "@dream/agent-context"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { NodeServices } from "@effect/platform-node"
import { ConfigProvider, DateTime, Effect, Layer, Option, Result } from "effect"
import { CliOutput, Command } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { dream } from "../src/Cli.ts"
import { Dream } from "../src/cli/Client.ts"
import { pageCheck } from "../src/cli/Format.ts"
import { PageCheck, PageLoad } from "../src/cli/PageCheck.ts"
import { checkCron, mediaType, parseAt, parseStep, planCopy } from "../src/cli/Parse.ts"
import { requestedSecret } from "../src/cli/Secrets.ts"
import { invalidInvocation } from "../src/cli/Usage.ts"
import { publishedPorts, requestedTags } from "../src/Servers.ts"
import { parseSkill } from "../src/harness/Skill.ts"
import { harnessAuth, harnessEnv } from "../src/harness/HarnessEnv.ts"

const now = DateTime.makeUnsafe("2026-11-05T10:00:00Z")
const at = (input: string) => Result.map(parseAt(input, now), DateTime.formatIso)

describe("dream wake --at", () => {
  it("takes spans from now", () => {
    assert.deepStrictEqual(at("30m"), Result.succeed("2026-11-05T10:30:00.000Z"))
    assert.deepStrictEqual(at("in 1h30m"), Result.succeed("2026-11-05T11:30:00.000Z"))
    assert.deepStrictEqual(at("+2d"), Result.succeed("2026-11-07T10:00:00.000Z"))
  })

  it("takes ISO times with a zone, and refuses ones without", () => {
    assert.deepStrictEqual(at("2026-11-06T07:00:00-08:00"), Result.succeed("2026-11-06T15:00:00.000Z"))
    assert.deepStrictEqual(at("2026-11-06T07:00Z"), Result.succeed("2026-11-06T07:00:00.000Z"))
    assert.isTrue(Result.isFailure(at("2026-11-06T07:00")))
    assert.isTrue(Result.isFailure(at("tomorrow")))
  })

  it("checks cron expressions", () => {
    assert.isTrue(Result.isSuccess(checkCron("0 7 * * *")))
    assert.isTrue(Result.isFailure(checkCron("0 7 * *")))
    assert.isTrue(Result.isFailure(checkCron("99 7 * * *")))
  })
})

describe("other flags", () => {
  it("reads steps and media types", () => {
    assert.deepStrictEqual(parseStep("3/5"), Result.succeed({ current: 3, total: 5 }))
    assert.deepStrictEqual(mediaType("shot.PNG"), Result.succeed("image/png"))
    assert.isTrue(Result.isFailure(mediaType("notes.txt")))
  })
})

describe("dream mac cp", () => {
  it("copies to or from the Mac, never both or neither", () => {
    assert.deepStrictEqual(
      planCopy(["App", "project.yml", "mac:src"]),
      Result.succeed({ direction: "to-mac", sources: ["App", "project.yml"], destination: "src" })
    )
    assert.deepStrictEqual(
      planCopy(["mac:shot.png", "."]),
      Result.succeed({ direction: "from-mac", sources: ["shot.png"], destination: "." })
    )
    assert.isTrue(Result.isFailure(planCopy(["a", "b"])))
    assert.isTrue(Result.isFailure(planCopy(["mac:a", "mac:b"])))
    assert.isTrue(Result.isFailure(planCopy(["mac:a", "b", "c"])))
    assert.isTrue(Result.isFailure(planCopy(["mac:a"])))
  })
})

describe("the CLI socket", () => {
  it("sees which RPCs a request body calls", () => {
    const body = [
      JSON.stringify({ _tag: "Request", id: "1", tag: "SendMessage", payload: {}, headers: [] }),
      JSON.stringify({ _tag: "Request", id: "2", tag: "ReportUsage", payload: {}, headers: [] }),
      JSON.stringify({ _tag: "Ack", requestId: "1" }),
      "not json"
    ].join("\n")
    assert.deepStrictEqual(requestedTags(body), ["SendMessage", "ReportUsage"])
  })

  it("sees which ports a request body publishes", () => {
    const body = [
      JSON.stringify({ _tag: "Request", id: "1", tag: "Publish", payload: { port: 5173 }, headers: [] }),
      JSON.stringify({ _tag: "Request", id: "2", tag: "SendMessage", payload: { port: 1 }, headers: [] }),
      JSON.stringify({ _tag: "Request", id: "3", tag: "Publish", payload: { port: "x" }, headers: [] })
    ].join("\n")
    assert.deepStrictEqual(publishedPorts(body), [5173])
  })
})

describe("the harness environment", () => {
  it("keeps dreamd's tokens out of the agent's processes", () => {
    const env = harnessEnv(
      { PATH: "/usr/bin", DREAM_PROJECT_TOKEN: "p", DREAM_DAEMON_TOKEN: "d", DREAM_SOCKET: "/tmp/dreamd.sock" },
      { HOME: "/home/user" }
    )
    assert.deepStrictEqual(env, { PATH: "/usr/bin", DREAM_SOCKET: "/tmp/dreamd.sock", HOME: "/home/user" })
  })

  it("gives each harness a placeholder credential and no refreshable login", () => {
    assert.deepStrictEqual(Object.keys(harnessAuth("claude-code")), ["CLAUDE_CODE_OAUTH_TOKEN"])
    assert.deepStrictEqual(harnessAuth("codex"), {
      CODEX_API_KEY: "dream-placeholder",
      OPENAI_BASE_URL: "https://chatgpt.com/backend-api/codex"
    })
  })

  it("installs the dream skill with its name and description", () => {
    const skill = Option.getOrThrow(parseSkill(dreamSkill))
    assert.strictEqual(skill.name, "dream")
    assert.include(skill.description, "Reaching the person and Dream")
    assert.isTrue(skill.content.startsWith("# `dream`"))
  })
})

/**
 * Run `dream` with `args`, against a dreamd socket that doesn't exist: what an
 * invalid invocation prints, or the message the command failed with.
 */
const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const printed: Array<string> = []
    const presenter = CliOutput.layerPresenter({
      present: (event) =>
        Effect.sync(() => {
          if (event._tag === "InvalidInvocation") printed.push(invalidInvocation(event))
        })
    })
    const failure = yield* Command.runWith(dream, { version: "test" })(args).pipe(
      Effect.provide(presenter),
      Effect.flip
    )
    return printed[0] ?? failure.message
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Dream.layer,
        FetchHttpClient.layer,
        NodeServices.layer,
        PageCheck.layerTest(Effect.die("no page checks here"))
      ).pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { DREAM_SOCKET: "/nonexistent/dreamd.sock" } }))
        )
      )
    )
  )

describe("dream usage errors", () => {
  it.effect("lead with what's missing and how to fill it in, then an example, not the help text", () =>
    Effect.gen(function* () {
      const printed = yield* run([
        "access",
        "key",
        "--service",
        "Discord",
        "--header",
        "Authorization",
        "--format",
        "Bot {key}"
      ])
      const lines = printed.split("\n")
      assert.strictEqual(lines[0], "--host is missing: the API host the key is sent to, like discord.com.")
      assert.strictEqual(
        lines[1],
        'Example: dream access key --service Discord --host discord.com --header Authorization --format "Bot {key}" --why "Post quotes to your channel"'
      )
      assert.strictEqual(lines[2], "Usage: dream access key [flags]. All flags: `dream access key --help`.")
      assert.lengthOf(lines, 3)
    })
  )

  it.effect("name missing arguments and bad values the same way", () =>
    Effect.gen(function* () {
      assert.isTrue((yield* run(["wake", "cancel"])).startsWith("<wake-id> is missing.\nExample: dream wake cancel"))
      assert.isTrue((yield* run(["publish", "--port", "abc"])).startsWith('Invalid value for flag --port: "abc".'))
      assert.isTrue((yield* run(["acess"])).startsWith('Unknown subcommand "acess" for "dream"'))
    })
  )
})

describe("dream ask and secrets", () => {
  const asks = (...texts: Array<string>) => Option.getOrUndefined(requestedSecret(texts))

  it("spots questions that ask them for a credential", () => {
    assert.strictEqual(asks("What's your Discord bot token?"), "bot token")
    assert.strictEqual(asks("Paste the token from the Developer Portal here"), "token")
    assert.strictEqual(asks("Do you have a Stripe API key?"), "api key")
    assert.strictEqual(asks("Can you share the client secret for the Spotify app?"), "client secret")
    assert.strictEqual(asks("What's the password for your router?", "", "I'll type it"), "password")
    assert.strictEqual(asks("Please send the 2FA code you just got"), "2fa code")
    assert.strictEqual(asks("Which account?", "I need your AWS secret access key to deploy"), "secret access key")
    assert.strictEqual(asks("Ready to go?", "", "Yes, here's my private key"), "private key")
    // From QA: markdown, and the request far from the credential.
    assert.strictEqual(
      asks(
        "I need two things:\n\n1. **Discord Bot Token** — from the Developer Portal\n2. **Channel ID**\n\nOnce you provide these, I'll start.",
        "",
        "Ready to provide"
      ),
      "bot token"
    )
    assert.strictEqual(asks("Are you copying the **Bot Token** (not the Application ID)?"), "bot token")
    assert.strictEqual(asks("Ready to save your credentials securely."), "credentials")
  })

  it("lets through questions that only mention credentials, or none", () => {
    assert.isUndefined(asks("Which email provider do you use?"))
    assert.isUndefined(asks("Should the API be public?"))
    assert.isUndefined(asks("Should users sign in with a password or a magic link?"))
    assert.isUndefined(asks("Should the app let users enter a password, or only use Google?"))
    assert.isUndefined(asks("What's the minimum password length?"))
    assert.isUndefined(asks("Should I send a password reset email?"))
    assert.isUndefined(asks("Should your API use API keys or OAuth?"))
    assert.isUndefined(asks("Which crypto token should your wallet show first?"))
    assert.isUndefined(asks("Do you have a Discord server already?", "", "Yes", "No"))
    assert.isUndefined(asks("Should design tokens follow your brand colors?"))
    assert.isUndefined(asks("Do you use 1Password?"))
    assert.isUndefined(asks("Which keyboard shortcuts should it have?"))
  })

  it.effect("refuses to send one, pointing at dream access key and the escape hatch", () =>
    Effect.gen(function* () {
      const refused = yield* run(["ask", "What's your Discord bot token?", "--option", "I'll paste it"])
      assert.isTrue(refused.startsWith('Not sent: this asks them for a secret ("bot token").'))
      assert.include(refused, "visible in Chat and arrive in this sandbox")
      assert.include(
        refused,
        'dream access key --service Discord --host discord.com --header Authorization --format "Bot {key}"'
      )
      assert.include(refused, "--not-a-secret")
    })
  )

  it.effect("sends it with --not-a-secret", () =>
    Effect.gen(function* () {
      const sent = yield* run(["ask", "What's your Discord bot token?", "--not-a-secret"])
      assert.isTrue(sent.startsWith("Couldn't reach Dream through dreamd"), sent)
    })
  )
})

describe("dream publish's check", () => {
  const loaded = (fields: Partial<Omit<Extract<PageLoad, { _tag: "Loaded" }>, "_tag">>) =>
    PageLoad.cases.Loaded.make({
      via: "browser",
      status: 200,
      pageErrors: [],
      consoleErrors: [],
      failedRequests: [],
      stillLoading: false,
      ...fields
    })

  it("says what the page answers, with its title", () => {
    assert.strictEqual(
      pageCheck(loaded({ contentType: "text/html; charset=utf-8", title: "Habit Tracker", firstLine: "Today" })),
      'Loaded it from this sandbox in Chromium: 200 text/html, title "Habit Tracker"'
    )
  })

  it("quotes the body of an error", () => {
    assert.strictEqual(
      pageCheck(
        loaded({
          via: "http",
          status: 403,
          contentType: "text/plain",
          firstLine: `Blocked request. This host ("3000-abc.e2b.app") is not allowed.`
        })
      ),
      `Loaded it from this sandbox over HTTP (no browser, so page errors weren't checked): 403 text/plain, "Blocked request. This host ("3000-abc.e2b.app") is not allowed."`
    )
  })

  it("lists page errors and failed requests, at most ten lines", () => {
    const text = pageCheck(
      loaded({
        contentType: "text/html",
        title: "Air",
        pageErrors: ["TypeError: Cannot read properties of undefined (reading 'pm2_5')\n    at App (App.tsx:12)"],
        failedRequests: ["404 https://x/a.js", "404 https://x/b.js", "500 https://x/api", "404 https://x/c.css"],
        consoleErrors: ["one", "two"]
      })
    )
    assert.strictEqual(
      text,
      [
        'Loaded it from this sandbox in Chromium: 200 text/html, title "Air"',
        "1 page error:",
        "  TypeError: Cannot read properties of undefined (reading 'pm2_5')",
        "4 failed requests:",
        "  404 https://x/a.js",
        "  404 https://x/b.js",
        "  500 https://x/api",
        "  … and 1 more",
        "2 console errors:",
        "… 2 more lines"
      ].join("\n")
    )
  })

  it("says when nothing answered in time, or the page never finished loading", () => {
    assert.strictEqual(
      pageCheck(PageLoad.cases.Unreachable.make({ via: "http", message: "no response within 10s" })),
      "Loading it from this sandbox over HTTP (no browser, so page errors weren't checked) failed: no response within 10s."
    )
    assert.strictEqual(
      pageCheck(loaded({ contentType: "text/html", stillLoading: true })),
      "Loaded it from this sandbox in Chromium: 200 text/html; still loading when the check stopped."
    )
  })

  it.live("loads a real URL", () =>
    Effect.gen(function* () {
      const server = createServer((_, response) => {
        response.writeHead(403, { "content-type": "text/plain" })
        response.end('Blocked request. This host ("localhost") is not allowed.\nTo allow this host, …')
      })
      yield* Effect.acquireRelease(
        Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
        () => Effect.sync(() => server.close())
      )
      const { port } = server.address() as AddressInfo
      const load = yield* Effect.gen(function* () {
        return yield* (yield* PageCheck).check(`http://127.0.0.1:${port}/`)
      }).pipe(Effect.provide(PageCheck.layer.pipe(Layer.provide([FetchHttpClient.layer, NodeServices.layer]))))
      assert.strictEqual(load._tag, "Loaded")
      assert.include(pageCheck(load), `403 text/plain, "Blocked request. This host ("localhost") is not allowed."`)
    }).pipe(Effect.scoped)
  )
})
