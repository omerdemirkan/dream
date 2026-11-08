import { assert, describe, it } from "@effect/vitest"
import { DiscordDefaultIntents, type IntegrationId, type Relay, type RelayId, RelaySource } from "@dream/domain"
import { skillNames, skills } from "@dream/agent-context"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { NodeServices } from "@effect/platform-node"
import { ConfigProvider, DateTime, Effect, Layer, Option, Result } from "effect"
import { CliOutput, Command } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { dream } from "../src/Cli.ts"
import { Dream } from "../src/cli/Client.ts"
import {
  accessRequested,
  integrations,
  linkAdded,
  mac,
  pageCheck,
  relay,
  relayAdded,
  status
} from "../src/cli/Format.ts"
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
import * as Skill from "../src/harness/Skill.ts"
import { parseSkill } from "../src/harness/Skill.ts"
import { agentEnv, commandEnv, harnessAuth, harnessEnv, sessionEnv } from "../src/harness/HarnessEnv.ts"

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

describe("dream mac", () => {
  it("says what stops it, and when Namespace will at the latest", () => {
    const now = DateTime.makeUnsafe("2026-11-08T10:00:00Z")
    const text = mac(
      {
        state: "running",
        idleTimeoutMinutes: 15,
        startedAt: DateTime.makeUnsafe("2026-11-08T09:30:00Z"),
        deadline: DateTime.makeUnsafe("2026-11-08T13:30:00Z")
      },
      now
    )
    assert.include(text, "it stops after 15 minutes with nothing running on it")
    assert.include(text, "Namespace destroys it at 2026-11-08T13:30Z")
    assert.notInclude(mac({ state: "running", idleTimeoutMinutes: 15 }, now), "Namespace")
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

  it("leaves Claude Code's background tasks on, since turns wait for them", () => {
    const env = agentEnv({ PATH: "/usr/bin" }, { home: "/home/user", socket: "/tmp/dreamd.sock" })
    assert.isUndefined(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)
  })

  it("points Node and Python at the system CA bundle, which trusts E2B's egress, unless already set", () => {
    const config = { home: "/home/user", socket: "/tmp/dreamd.sock" }
    const env = agentEnv({ PATH: "/usr/bin" }, config)
    for (const name of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"]) {
      assert.strictEqual(env[name], "/etc/ssl/certs/ca-certificates.crt")
    }
    assert.strictEqual(agentEnv({ SSL_CERT_FILE: "/mine.pem" }, config).SSL_CERT_FILE, "/mine.pem")
  })

  it("gives each harness a placeholder credential and no refreshable login", () => {
    assert.deepStrictEqual(Object.keys(harnessAuth("claude-code")), ["CLAUDE_CODE_OAUTH_TOKEN"])
    assert.deepStrictEqual(harnessAuth("codex"), {
      CODEX_API_KEY: "dream-placeholder",
      OPENAI_BASE_URL: "https://chatgpt.com/backend-api/codex"
    })
  })

  it("gives the AI gateway's variables to commands and Claude Code's tools, never to Codex itself", () => {
    const on = {
      home: "/home/user",
      socket: "/tmp/dreamd.sock",
      openaiBaseUrl: Option.some("https://openai.dream.test/v1")
    }
    const gateway = { OPENAI_BASE_URL: "https://openai.dream.test/v1", OPENAI_API_KEY: "dream-openai-placeholder" }
    assert.deepInclude(commandEnv({ PATH: "/usr/bin" }, on), gateway)
    assert.deepInclude(sessionEnv("claude-code", { PATH: "/usr/bin" }, on), gateway)
    const codex = sessionEnv("codex", { PATH: "/usr/bin" }, on)
    assert.isUndefined(codex.OPENAI_BASE_URL)
    assert.isUndefined(codex.OPENAI_API_KEY)
    const off = commandEnv({ PATH: "/usr/bin" }, { ...on, openaiBaseUrl: Option.none() })
    assert.isUndefined(off.OPENAI_BASE_URL)
    // Node, Bun and Python trust the system's CAs, E2B's egress CA among them; a value already set stays.
    assert.strictEqual(off.NODE_EXTRA_CA_CERTS, "/etc/ssl/certs/ca-certificates.crt")
    assert.strictEqual(commandEnv({ SSL_CERT_FILE: "/mine.pem" }, on).SSL_CERT_FILE, "/mine.pem")
  })

  it("offers the dream-openai skill only while the gateway is on", () =>
    Effect.gen(function* () {
      const all = yield* Skill.all
      const off = Skill.offered(all, { openaiBaseUrl: Option.none() })
      const on = Skill.offered(all, { openaiBaseUrl: Option.some("https://openai.dream.test/v1") })
      assert.notInclude(
        off.map((skill) => skill.name),
        "dream-openai"
      )
      assert.include(on.find((skill) => skill.name === "dream-openai")?.content, "OPENAI_BASE_URL")
      assert.strictEqual(on.length, off.length + 1)
    }).pipe(Effect.runSync))

  it("installs every skill with its name, description and body", () => {
    const parsed = skills.map((markdown) => Option.getOrThrow(parseSkill(markdown)))
    assert.deepStrictEqual(
      parsed.map((skill) => skill.name),
      [...skillNames]
    )
    for (const skill of parsed) {
      assert.isAbove(skill.description.length, 40, skill.name)
      assert.isTrue(skill.content.startsWith("# "), skill.name)
    }
    const chat = parsed.find((skill) => skill.name === "dream-chat")
    assert.include(chat?.description, "Sending the person anything")
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
      assert.isTrue(
        (yield* run(["wake", "cancel"])).startsWith(
          "<wake-id> is missing: the wake-up (wak_…), from `dream wake list`.\nExample: dream wake cancel"
        )
      )
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

describe("dream ask --show", () => {
  it.effect("refuses a preview for no option, or files that aren't there, before uploading anything", () =>
    Effect.gen(function* () {
      const stray = yield* run(["ask", "Which way?", "--option", "Calendar", "--show", "Rotation=c.png"])
      assert.include(stray, `--show names "Rotation", which isn't one of the options ("Calendar")`)
      const none = yield* run(["ask", "Which way?", "--option", "Calendar", "--show", "Calendar=/nonexistent/*.png"])
      assert.include(none, "No files match /nonexistent/*.png")
      const twice = yield* run(["ask", "Which way?", "--option", "A", "--show", "A=a.png", "--show", "A=b.png"])
      assert.include(twice, "more than one preview")
      const audio = yield* run(["message", "Listen", "--media", "chime.m4a"])
      assert.include(audio, "only as an option's preview")
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
    assert.include(out, "It takes two lines on the card above their Chat")
    assert.include(out, "Track: 3 of 5 (Progress charts)")
    assert.include(out, 'need: amber "Needs your Apple Developer account" while msg_apple is open')
    assert.include(out, "Not shown in the app: just did, next.")
    const short = status({ ...Fx.liftLogStatus, now: "Building the charts" }, now)
    assert.include(short, `Now: "Building the charts" (fits the card's one line)`)
    const long = status(
      {
        ...Fx.liftLogStatus,
        now: `${Fx.liftLogStatus.now} Then the rest timer, with its own Live Activity and sounds.`
      },
      now
    )
    assert.include(long, "Too long: the card above their Chat cuts it to two lines")
  })
})

describe("dream relay", () => {
  it.effect("checks the path and the feed before asking Dream", () =>
    Effect.gen(function* () {
      assert.include(yield* run(["relay", "discord", "--to", "hooks/discord"]), 'starts with "/"')
      assert.include(yield* run(["relay", "websocket", "ws://feed.example.com", "--to", "/hooks"]), "wss://")
      assert.isTrue((yield* run(["relay", "discord"])).startsWith("--to is missing: the path on your app"))
      assert.isTrue(
        (yield* run(["relay", "remove"])).startsWith(
          "<relay-id> is missing: the relay (rly_…), from `dream relay list`.\nExample: dream relay remove"
        )
      )
      // A good invocation gets past the checks, to the socket (absent here).
      assert.notInclude(yield* run(["relay", "discord", "--to", "/hooks/discord"]), "--to")
    })
  )

  const base: Relay = {
    id: "rly_1" as RelayId,
    source: RelaySource.cases.Discord.make({
      integrationId: "int_1" as IntegrationId,
      intents: DiscordDefaultIntents,
      events: ["MESSAGE_CREATE"],
      mentionsOnly: true
    }),
    target: { path: "/hooks/discord", port: 3000 },
    createdAt: DateTime.makeUnsafe("2026-11-05T08:00:00Z"),
    state: "connected",
    since: DateTime.makeUnsafe("2026-11-05T08:00:00Z"),
    account: "Helper#0001",
    waiting: 0,
    delivered: 12,
    dropped: 0,
    problems: []
  }

  it("prints what it holds, where it delivers and how it's doing", () => {
    assert.strictEqual(
      relay(base, now),
      [
        "rly_1: Discord MESSAGE_CREATE (only mentions and DMs) → localhost:3000 /hooks/discord",
        "  connected for 2h 0m as Helper#0001; 12 delivered, 0 waiting"
      ].join("\n")
    )
    const failing: Relay = {
      ...base,
      label: "prices",
      source: RelaySource.cases.WebSocket.make({ url: "wss://feed.example.com", send: [] }),
      target: { path: "/hooks/feed" },
      state: "failed",
      since: DateTime.makeUnsafe("2026-11-05T09:55:00Z"),
      waiting: 3,
      dropped: 1,
      problems: [{ at: DateTime.makeUnsafe("2026-11-05T09:55:00Z"), message: "The feed refused the key (401)." }]
    }
    assert.strictEqual(
      relay(failing, now),
      [
        'rly_1 "prices": WebSocket wss://feed.example.com → the published port /hooks/feed',
        "  failed 5m ago; `dream relay restart rly_1` once it's fixed; 12 delivered, 3 waiting, 1 dropped",
        "  5m ago: The feed refused the key (401)."
      ].join("\n")
    )
    assert.include(relayAdded(base, now), "signed with the key in /home/user/.dream/relay.key")
  })
})
