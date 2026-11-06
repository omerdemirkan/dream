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
import { accessRequested, integrations, linkAdded, pageCheck, status } from "../src/cli/Format.ts"
import * as Fx from "@dream/domain/fixtures"
import { PageCheck, PageLoad } from "../src/cli/PageCheck.ts"
import {
  checkCron,
  iconImageProblem,
  iconInput,
  imageSize,
  mediaType,
  parseAt,
  parseStep,
  planCopy
} from "../src/cli/Parse.ts"
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
      assert.strictEqual(
        lines[0],
        "--host is missing: the API host the key is sent to, like discord.com: a bare DNS name, no https:// or path."
      )
      assert.strictEqual(
        lines[1],
        'Example: dream access key --service Discord --host discord.com --header Authorization --format "Bot {key}" --why "Add your Discord bot key so it can post quotes to your channel" --context "In the [Developer Portal](https://discord.com/developers/applications), open your app, tap **Bot**, then **Reset Token**, and copy it."'
      )
      assert.strictEqual(lines[2], "Usage: dream access key [flags]. All flags: `dream access key --help`.")
      assert.lengthOf(lines, 3)
    })
  )

  it.effect("refuse a key host that no request goes to, before asking them", () =>
    Effect.gen(function* () {
      const key = (host: string) =>
        run(
          ["access", "key", "--service", "Spotify", "--host", host, "--header", "Authorization"].concat([
            "--format",
            "Bearer {key}",
            "--why",
            "Play your playlists"
          ])
        )
      assert.strictEqual(
        yield* key("spotify-oauth"),
        "--host \"spotify-oauth\" isn't a hostname that requests go to; it should be a bare DNS name like api.stripe.com (no scheme, path, port or spaces, at least one dot), the API's real host."
      )
      assert.strictEqual(
        yield* key("https://api.spotify.com/v1"),
        '--host "https://api.spotify.com/v1" should be just the hostname: --host api.spotify.com.'
      )
      // A good host gets past the check, to the socket (absent here).
      assert.notInclude(yield* key("api.spotify.com"), "--host")
    })
  )

  it.effect("refuse a key file name that isn't one plain file name, and default it from the service", () =>
    Effect.gen(function* () {
      const file = (...flags: Array<string>) =>
        run(["access", "file", "--service", "Telegram", ...flags, "--why", "Run your bot"])
      assert.include(yield* file("--name", "../dreamd.env"), '--name "../dreamd.env" should be a short file name')
      // A good name, or none, gets past the check, to the socket (absent here).
      assert.notInclude(yield* file("--name", "telegram-bot-token"), "--name")
      assert.notInclude(yield* file(), "--name")
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

describe("dream access oauth", () => {
  it.effect("needs a provider, and says so with an example", () =>
    Effect.gen(function* () {
      const printed = yield* run(["access", "oauth", "--why", "Build playlists"])
      assert.isTrue(printed.startsWith("<provider> is missing"), printed)
      assert.include(printed, "Example: dream access oauth spotify --scopes user-read-private,playlist-modify-private")
    })
  )

  it("prints what it asked for and what's connected, with the provider's notes", () => {
    const createdAt = DateTime.makeUnsafe("2026-11-05T10:00:00Z")
    const requested = accessRequested({
      _tag: "Access",
      id: "msg_1" as never,
      projectId: "prj_1" as never,
      createdAt,
      request: { _tag: "OAuth", provider: "spotify", service: "Spotify", scopes: ["user-read-private"] },
      why: "Connect Spotify so I can build playlists",
      state: { _tag: "Open" }
    })
    assert.strictEqual(
      requested,
      "Asked for Spotify (user-read-private) as msg_1. You'll get an event when they connect."
    )
    const listed = integrations([
      {
        id: "int_1" as never,
        label: "GitHub",
        status: "connected",
        connectedAt: createdAt,
        access: {
          _tag: "OAuth",
          provider: "github",
          service: "GitHub",
          account: "octocat",
          scopes: ["repo"],
          hosts: ["api.github.com", "github.com"],
          placeholder: "dream-github-oauth-placeholder",
          notes: "api.github.com refuses requests without a User-Agent header."
        }
      }
    ])
    assert.strictEqual(
      listed,
      'GitHub [connected] OAuth as octocat (repo); hosts api.github.com, github.com; placeholder "dream-github-oauth-placeholder"\n' +
        "  api.github.com refuses requests without a User-Agent header."
    )
  })
})

describe("dream access --why", () => {
  it("tells the agent the heading its card shows when --why doesn't name the service", () => {
    const requested = accessRequested({
      _tag: "Access",
      id: "msg_1" as never,
      projectId: "prj_1" as never,
      createdAt: DateTime.makeUnsafe("2026-11-05T10:00:00Z"),
      request: {
        _tag: "Key",
        service: "OpenAI",
        host: "api.openai.com",
        header: "Authorization",
        format: "Bearer {key}"
      },
      why: "Powers the voice coach",
      state: { _tag: "Open" }
    })
    assert.isTrue(requested.endsWith(' Its heading reads "Add your OpenAI key", with your --why under it.'), requested)
  })
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

describe("dream link", () => {
  it("reads --icon as a symbol, an emoji, a file, or nothing", () => {
    assert.deepStrictEqual(iconInput("dumbbell"), Result.succeed({ _tag: "Symbol", name: "dumbbell" }))
    assert.deepStrictEqual(iconInput("🏋️"), Result.succeed({ _tag: "Emoji", emoji: "🏋️" }))
    assert.deepStrictEqual(iconInput("art/icon.PNG"), Result.succeed({ _tag: "File", path: "art/icon.PNG" }))
    assert.deepStrictEqual(iconInput(""), Result.succeed({ _tag: "Clear" }))
    assert.isTrue(Result.isFailure(iconInput("Dumbbell Icon")))
  })

  it("wants a square image of at least 180 px", () => {
    const png = (width: number, height: number) => {
      const bytes = new Uint8Array(24)
      const view = new DataView(bytes.buffer)
      view.setUint32(0, 0x89504e47)
      view.setUint32(16, width)
      view.setUint32(20, height)
      return bytes
    }
    assert.deepStrictEqual(imageSize(png(512, 512)), { width: 512, height: 512 })
    assert.isUndefined(iconImageProblem("icon.png", imageSize(png(512, 512))))
    assert.include(iconImageProblem("icon.png", imageSize(png(512, 300)))!, "has to be square")
    assert.include(iconImageProblem("icon.png", imageSize(png(64, 64)))!, "at least 180")
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03])
    assert.deepStrictEqual(imageSize(jpeg), { width: 512, height: 256 })
  })

  it("says what they'll see", () => {
    const cabin = Fx.links[2]!
    assert.deepStrictEqual(
      linkAdded({ link: cabin, projectTitle: "Cabin", publicUrl: Fx.cabin.publicUrl }).split("\n"),
      [
        "Added lnk_cabin to their Home, at the end of the row of app icons.",
        'On their Home it shows as "Cabin" under the SF Symbol house on a green tile, with a dot before the label until they first open it.',
        'Held, it reads "Made by Cabin · cabin-k3x9q2.dream.example".',
        "Added to their iPhone's Home Screen, it's an app called \"Cabin\" with this tile as its icon."
      ]
    )
  })

  it.effect("refuses what wouldn't show right before asking Dream", () =>
    Effect.gen(function* () {
      const add = (...args: Array<string>) => run(["link", "add", "https://cabin-7fq2.omer.build", ...args])
      assert.include(yield* add("--title", "Cabin weekend booking tool", "--color", "green"), "is 26 characters")
      assert.include(yield* add("--title", "Cabin", "--icon", "house"), "--color is missing")
      assert.include(yield* add("--title", "Cabin", "--icon", "House Icon", "--color", "green"), "isn't an SF Symbol")
      assert.include(
        yield* run(["link", "add", "http://x.example", "--title", "X", "--color", "red"]),
        "must start with https://"
      )
      assert.include(yield* run(["link", "update", "lnk_x"]), "at least one of")
      // A good link gets past the checks, to the socket (absent here).
      assert.notInclude(yield* add("--title", "Cabin", "--icon", "house", "--color", "green"), "--")
    })
  )
})

describe("dream status", () => {
  it("echoes what the card shows: the now line as cut, the track, needs, and what's not shown", () => {
    const now = DateTime.makeUnsafe("2026-11-04T22:12:00Z")
    const out = status(Fx.liftLogStatus, now)
    assert.include(out, "The card above their Chat cuts it to")
    assert.include(out, "Track: 3 of 5 (Progress charts)")
    assert.include(out, 'need: amber "Needs your Apple Developer account" while msg_apple is open')
    assert.include(out, "Not shown in the app: just did, next.")
    const short = status({ ...Fx.liftLogStatus, now: "Building the charts" }, now)
    assert.include(short, `Now: "Building the charts" (fits the card's one line)`)
  })
})
