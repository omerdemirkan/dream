/**
 * Fakes for every external service the control plane calls. Each records
 * what it was asked so tests can assert on it.
 */
import { DaemonEnv, DaemonEnvFile, DaemonRestarting, UpstreamFailure } from "@dream/domain"
import { DateTime, Effect, Layer, Option, Stream } from "effect"
import { Browserbase } from "../../src/brokers/Browserbase.ts"
import { Namespace } from "../../src/brokers/Namespace.ts"
import { ChatGpt } from "../../src/connect/ChatGpt.ts"
import { Daemon } from "../../src/e2b/Daemon.ts"
import { E2B, type NetworkRules, type SandboxAccess, SandboxGone } from "../../src/e2b/E2B.ts"
import { Envd, type ProcessOutput } from "../../src/e2b/Envd.ts"
import { Google, GoogleOAuthSpec } from "../../src/integrations/Google.ts"
import { OAuth, OAuthProviders } from "../../src/integrations/OAuth.ts"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Apns } from "../../src/push/Apns.ts"
import { Tokens } from "../../src/auth/Tokens.ts"

const base64Url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const unsignedJwt = (claims: object) => `${base64Url({ alg: "RS256", typ: "JWT" })}.${base64Url(claims)}.c2ln`

export interface FakeSandbox {
  readonly access: SandboxAccess
  readonly template: string
  state: "running" | "paused" | "killed"
  /** When it last started or resumed (E2B's run cap counts from here). */
  startedAt: DateTime.Utc
  pauses: number
  resumes: number
  rules: NetworkRules
  timeoutSeconds: number
  /** When it pauses: its timeout from when the timeout was last set. */
  endAt: DateTime.Utc
  /** How many times its timeout was set, by `connect` or `setTimeout`. */
  timeoutsSet: number
  readonly files: Map<string, string>
  readonly metadata: Readonly<Record<string, string>>
  /** The Dream release its dreamd runs (`/opt/dream/release.json`), and one staged by a refresh. */
  release: string | undefined
  staged?: string | undefined
  previous?: string | undefined
}

export class FakeWorld {
  readonly sandboxes = new Map<string, FakeSandbox>()
  readonly delivered: Array<{
    sandboxId: string
    events: ReadonlyArray<unknown>
    timeZone: string | undefined
    /** What the dreamd that took them had read. */
    envHash: string | undefined
  }> = []
  readonly pushes: Array<{ readonly token: string; readonly kind: string; readonly payload: unknown }> = []
  readonly processes: Array<{ sandboxId: string; command: string; pty: boolean }> = []
  readonly inputs: Array<{ sandboxId: string; pid: number; text: string }> = []
  readonly browserSessions = new Map<string, { status: string; startedAt: string; endedAt?: string }>()
  readonly macs = new Map<string, { status: string; labels?: Record<string, string> }>()
  daemonHealthy = true
  deliverFails = false
  /** Deliveries dreamd refuses because it's restarting. */
  deliverRestarting = 0
  /**
   * The dreamd running in each sandbox: the env hash it read at start. After the env file changes, the old
   * process answers `restartLag` more health checks before the new one replaces it.
   */
  readonly daemons = new Map<string, { envHash: string | undefined; lagLeft?: number }>()
  restartLag = 0
  /** Health checks dreamd answered, with the hash it reported. */
  readonly healthChecks: Array<string | undefined> = []
  /** What a started process prints, by a substring of its command. */
  readonly scripts = new Map<string, ReadonlyArray<ProcessOutput>>()
  /** What a reattached process prints after input. */
  attachOutput: ReadonlyArray<ProcessOutput> = []
  /** Each template's newest ready build, and the release a sandbox of it gets. */
  readonly templateBuilds = new Map<string, { build: string; release: string | undefined }>()
  /** Builds aren't tagged with their release (as before the template build tagged them). */
  untaggedBuilds = false
  /** `envd.run` results for commands containing a key; the first match wins. */
  readonly runResults = new Map<string, { exitCode: number; output: string }>()
  /** A refreshed dreamd that never answers with its release. */
  newDaemonSilent = false
  /** Relay deliveries dreamd was handed, by sandbox, with the port and path it posted them to. */
  readonly relayForwards: Array<{
    sandboxId: string
    relayId: string
    port: number
    path: string
    ids: ReadonlyArray<string>
  }> = []
  /** How the app answers relay deliveries: how many of each batch it takes, and why not the rest. */
  relayApp: (count: number) => { delivered: number; failure?: { message: string; status?: number } } = (count) => ({
    delivered: count
  })
  /** Turn state dreamd reports, per sandbox (default idle). */
  readonly turns = new Map<string, "idle" | "running">()
  googleRefreshes = 0
  chatGptRefreshes = 0
  /** OAuth providers this deployment has credentials for (the rest of the catalog isn't set up). */
  oauthConfigured: ReadonlyArray<string> = ["spotify", "github", "slack", "notion", "dropbox"]
  /** Every request to an OAuth provider, with its form or JSON body. */
  readonly oauthRequests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []
  /**
   * How providers answer, by `METHOD url` (without the query); unset ones answer 404. Google's token endpoint
   * answers a code with google-access-1 / google-refresh-1 for omer@example.com, and each refresh with the next
   * access token (counted in `googleRefreshes`).
   */
  readonly oauthResponses = new Map<string, (request: { readonly body: string }) => { status?: number; body: unknown }>(
    [
      [
        `POST ${GoogleOAuthSpec.tokenUrl}`,
        ({ body }) => {
          if (new URLSearchParams(body).get("grant_type") === "refresh_token") {
            this.googleRefreshes++
            return { body: { access_token: `google-access-${this.googleRefreshes + 1}`, expires_in: 3600 } }
          }
          return {
            body: {
              access_token: "google-access-1",
              expires_in: 3600,
              refresh_token: "google-refresh-1",
              scope: "https://www.googleapis.com/auth/gmail.readonly",
              id_token: unsignedJwt({ email: "omer@example.com" })
            }
          }
        }
      ]
    ]
  )
  private counter = 0
  nextId = (prefix: string) => `${prefix}${++this.counter}`
}

export const fakeE2B = (world: FakeWorld) =>
  Layer.succeed(
    E2B,
    E2B.of({
      create: (options) =>
        Effect.map(DateTime.now, (now) => {
          const sandboxId = world.nextId("sbx")
          const release = world.templateBuilds.get(options.template)?.release
          const access = {
            sandboxId,
            domain: "e2b.test",
            envdAccessToken: `envd-${sandboxId}`,
            trafficAccessToken: `traffic-${sandboxId}`
          }
          world.sandboxes.set(sandboxId, {
            access,
            template: options.template,
            state: "running",
            startedAt: now,
            pauses: 0,
            resumes: 0,
            rules: options.rules,
            timeoutSeconds: options.timeoutSeconds,
            endAt: DateTime.add(now, { seconds: options.timeoutSeconds }),
            timeoutsSet: 0,
            files: new Map(release === undefined ? [] : [["/opt/dream/release.json", JSON.stringify({ release })]]),
            metadata: options.metadata,
            release
          })
          return access
        }),
      connect: (sandboxId, timeoutSeconds) => {
        const sandbox = world.sandboxes.get(sandboxId)
        if (sandbox === undefined || sandbox.state === "killed") return Effect.fail(new SandboxGone({ sandboxId }))
        return Effect.map(DateTime.now, (now) => {
          if (sandbox.state === "paused") {
            sandbox.resumes++
            sandbox.startedAt = now
          }
          sandbox.state = "running"
          sandbox.timeoutSeconds = timeoutSeconds
          sandbox.endAt = DateTime.add(now, { seconds: timeoutSeconds })
          sandbox.timeoutsSet++
          return sandbox.access
        })
      },
      info: (sandboxId) =>
        Effect.sync(() => {
          const sandbox = world.sandboxes.get(sandboxId)
          return sandbox === undefined
            ? Option.none()
            : Option.some({
                sandboxID: sandboxId,
                state: sandbox.state,
                startedAt: sandbox.startedAt,
                endAt: DateTime.formatIso(sandbox.endAt)
              })
        }),
      setTimeout: (sandboxId, timeoutSeconds) => {
        const sandbox = world.sandboxes.get(sandboxId)
        // Like E2B: a paused sandbox's timeout can't be set (404).
        if (sandbox === undefined || sandbox.state !== "running") return Effect.fail(new SandboxGone({ sandboxId }))
        return Effect.map(DateTime.now, (now) => {
          sandbox.timeoutSeconds = timeoutSeconds
          sandbox.endAt = DateTime.add(now, { seconds: timeoutSeconds })
          sandbox.timeoutsSet++
        })
      },
      updateRules: (sandboxId, rules) =>
        Effect.sync(() => {
          const sandbox = world.sandboxes.get(sandboxId)
          if (sandbox === undefined || sandbox.state !== "running") return false
          sandbox.rules = rules
          return true
        }),
      currentBuild: (template) =>
        Effect.sync(() =>
          Option.map(Option.fromUndefinedOr(world.templateBuilds.get(template)), (current) => ({
            build: current.build,
            release: world.untaggedBuilds ? Option.none() : Option.fromUndefinedOr(current.release)
          }))
        ),
      pause: (sandboxId) =>
        Effect.sync(() => {
          const sandbox = world.sandboxes.get(sandboxId)
          if (sandbox !== undefined && sandbox.state === "running") {
            sandbox.state = "paused"
            sandbox.pauses++
          }
        }),
      kill: (sandboxId) =>
        Effect.sync(() => {
          const sandbox = world.sandboxes.get(sandboxId)
          if (sandbox !== undefined) sandbox.state = "killed"
        })
    })
  )

/**
 * Just enough of the shell for the key files SandboxManager writes: `find <dir> -mindepth 1 -maxdepth 1
 * [! -name <n>]… -exec rm -rf {} +` and `mv -f <from> <to>`.
 */
const emulateFileCommands = (files: Map<string, string>, command: string) => {
  const find = /find (\S+) -mindepth 1 -maxdepth 1 (.*?)-exec rm -rf \{\} \+/.exec(command)
  if (find !== null) {
    const dir = find[1]!
    const keep = new Set([...find[2]!.matchAll(/! -name (\S+)/g)].map((match) => `${dir}/${match[1]}`))
    for (const path of [...files.keys()]) if (path.startsWith(`${dir}/`) && !keep.has(path)) files.delete(path)
  }
  const move = /mv -f (\S+) (\S+)/.exec(command)
  if (move !== null && files.has(move[1]!)) {
    files.set(move[2]!, files.get(move[1]!)!)
    files.delete(move[1]!)
  }
}

export const fakeEnvd = (world: FakeWorld) => {
  const outputFor = (command: string): ReadonlyArray<ProcessOutput> => {
    for (const [key, output] of world.scripts) if (command.includes(key)) return output
    return [{ _tag: "End", exitCode: 0 }]
  }
  return Layer.succeed(
    Envd,
    Envd.of({
      start: (sandbox, options) => {
        world.processes.push({ sandboxId: sandbox.sandboxId, command: options.command, pty: options.pty !== undefined })
        return Stream.fromIterable<ProcessOutput>([{ _tag: "Start", pid: 42 }, ...outputFor(options.command)])
      },
      attach: () => Stream.fromIterable(world.attachOutput),
      startBackground: (sandbox, options) =>
        Effect.sync(() => {
          world.processes.push({ sandboxId: sandbox.sandboxId, command: options.command, pty: false })
          return 42
        }),
      run: (sandbox, options) =>
        Effect.sync(() => {
          world.processes.push({ sandboxId: sandbox.sandboxId, command: options.command, pty: false })
          for (const [key, result] of world.runResults) if (options.command.includes(key)) return result
          const files = world.sandboxes.get(sandbox.sandboxId)?.files
          if (files !== undefined) emulateFileCommands(files, options.command)
          // A refresh, as the real scripts do it: stage the donor's release, swap it in, or put the old one back.
          const target = world.sandboxes.get(sandbox.sandboxId)
          if (target !== undefined) {
            const donorId = /49983-([^.]+)\./.exec(options.envs?.DONOR_URL ?? "")?.[1]
            if (donorId !== undefined) target.staged = world.sandboxes.get(donorId)?.release
            if (options.command.includes("refresh.sh activate")) {
              target.previous = target.release
              target.release = target.staged
            }
            if (options.command.includes("refresh.sh rollback") && target.previous !== undefined) {
              target.release = target.previous
            }
          }
          return { exitCode: 0, output: "" }
        }),
      sendInput: (sandbox, pid, text) =>
        Effect.sync(() => void world.inputs.push({ sandboxId: sandbox.sandboxId, pid, text })),
      kill: () => Effect.void,
      writeFile: (sandbox, path, content) =>
        Effect.sync(() => void world.sandboxes.get(sandbox.sandboxId)?.files.set(path, content)),
      readFile: (sandbox, path) =>
        Effect.sync(() => Option.fromUndefinedOr(world.sandboxes.get(sandbox.sandboxId)?.files.get(path)))
    })
  )
}

/** The `DaemonEnv.envHash` in a sandbox's env file. */
const fileEnvHash = (world: FakeWorld, sandbox: SandboxAccess): string | undefined => {
  const file = world.sandboxes.get(sandbox.sandboxId)?.files.get(DaemonEnvFile) ?? ""
  const line = file.split("\n").find((line) => line.startsWith(`${DaemonEnv.envHash}=`))
  return line === undefined ? undefined : JSON.parse(line.slice(DaemonEnv.envHash.length + 1))
}

/** The dreamd answering now: the one that read the current env file, unless the old one hasn't exited yet. */
const runningDaemon = (world: FakeWorld, sandbox: SandboxAccess) => {
  const envHash = fileEnvHash(world, sandbox)
  const running = world.daemons.get(sandbox.sandboxId)
  if (running !== undefined && running.envHash !== envHash) {
    running.lagLeft ??= world.restartLag
    if (running.lagLeft > 0) {
      running.lagLeft--
      return running
    }
  }
  if (running === undefined || running.envHash !== envHash) world.daemons.set(sandbox.sandboxId, { envHash })
  return world.daemons.get(sandbox.sandboxId)!
}

export const fakeDaemon = (world: FakeWorld) =>
  Layer.succeed(
    Daemon,
    Daemon.of({
      deliver: (sandbox, _token, events, timeZone) =>
        Effect.gen(function* () {
          if (world.deliverFails) return yield* new UpstreamFailure({ service: "dreamd", message: "down" })
          if (world.deliverRestarting > 0) {
            world.deliverRestarting--
            return yield* new DaemonRestarting({ message: "restarting" })
          }
          const { envHash } = runningDaemon(world, sandbox)
          world.delivered.push({ sandboxId: sandbox.sandboxId, events, timeZone, envHash })
          return events.map((event) => event.id)
        }),
      forwardRelay: (sandbox, _token, request) =>
        Effect.gen(function* () {
          if (world.deliverFails) return yield* new UpstreamFailure({ service: "dreamd", message: "down" })
          const fake = world.sandboxes.get(sandbox.sandboxId)
          // The request wakes a paused sandbox, as E2B's auto-resume does.
          if (fake !== undefined && fake.state === "paused") {
            fake.state = "running"
            fake.resumes++
          }
          const result = world.relayApp(request.deliveries.length)
          world.relayForwards.push({
            sandboxId: sandbox.sandboxId,
            relayId: request.relayId,
            port: request.port,
            path: request.path,
            ids: request.deliveries.slice(0, result.delivered).map((delivery) => delivery.id)
          })
          return result
        }),
      health: (sandbox) =>
        Effect.suspend(() => {
          if (!world.daemonHealthy) return Effect.fail(new UpstreamFailure({ service: "dreamd", message: "down" }))
          const { envHash } = runningDaemon(world, sandbox)
          world.healthChecks.push(envHash)
          const fake = world.sandboxes.get(sandbox.sandboxId)
          const release =
            fake?.release !== undefined && fake.release === fake.staged && world.newDaemonSilent
              ? fake.previous
              : fake?.release
          return Effect.succeed({
            version: "test",
            turn: world.turns.get(sandbox.sandboxId) ?? ("idle" as const),
            queued: 0,
            ...(envHash === undefined ? {} : { envHash }),
            ...(release === undefined ? {} : { release })
          })
        })
    })
  )

export const fakeBrowserbase = (world: FakeWorld) =>
  Layer.succeed(
    Browserbase,
    Browserbase.of({
      create: () =>
        Effect.sync(() => {
          const id = world.nextId("bb")
          world.browserSessions.set(id, { status: "RUNNING", startedAt: new Date().toISOString() })
          return {
            session: { id, status: "RUNNING" },
            connectUrl: `wss://connect.browserbase.test/?signingKey=${id}`,
            liveViewUrl: `https://www.browserbase.test/live/${id}`
          }
        }),
      get: (id) => Effect.sync(() => ({ id, ...(world.browserSessions.get(id) ?? { status: "COMPLETED" }) })),
      release: (id) =>
        Effect.sync(() => {
          const session = world.browserSessions.get(id)!
          session.status = "COMPLETED"
          // Three and a half minutes after it started: billed as four.
          session.endedAt = new Date(Date.now() + 210_000).toISOString()
          return { id, ...session }
        }),
      recording: (id) => Effect.succeed({ _tag: "Ready" as const, url: `https://cdn.browserbase.test/${id}.mp4` })
    })
  )

export const fakeNamespace = (world: FakeWorld) =>
  Layer.succeed(
    Namespace,
    Namespace.of({
      start: (_labels, deadline) =>
        Effect.sync(() => {
          const instanceId = world.nextId("mac")
          world.macs.set(instanceId, { status: "RUNNING" })
          return { instanceId, status: "RUNNING", deadline }
        }),
      describe: (instanceId) =>
        Effect.succeed({ instanceId, status: world.macs.get(instanceId)?.status ?? "DESTROYED" }),
      list: Effect.sync(() =>
        [...world.macs.entries()]
          .filter(([, mac]) => mac.status !== "DESTROYED")
          .map(([instanceId, mac]) => ({ instanceId, status: mac.status, labels: mac.labels }))
      ),
      ssh: (instanceId) =>
        Effect.succeed({
          host: "ssh.test.namespace.so",
          port: 22,
          user: instanceId,
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
          hostKey: "ssh.test.namespace.so ecdsa-sha2-nistp256 AAAA"
        }),
      extend: () => Effect.void,
      destroy: (instanceId) =>
        Effect.sync(() => {
          world.macs.set(instanceId, { status: "DESTROYED" })
        })
    })
  )

/** HTTP that answers from `world.oauthResponses` (recording each request) instead of reaching the providers. */
const providerHttp = (world: FakeWorld) => {
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = await request.text()
    world.oauthRequests.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body
    })
    const answer = world.oauthResponses.get(`${request.method} ${url.origin}${url.pathname}`)
    if (answer === undefined) return new Response("not found", { status: 404 })
    const { status, body: answered } = answer({ body })
    return new Response(status === 204 ? null : JSON.stringify(answered), {
      status: status ?? 200,
      headers: { "content-type": "application/json" }
    })
  }) as typeof globalThis.fetch
  // `Fetch` is read from the running fiber, so it's provided around each request.
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (http) =>
      http.pipe(HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, fetch)))
    )
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

/** The real OAuth client, talking to `world.oauthResponses` instead of the providers. */
export const fakeOAuth = (world: FakeWorld) => OAuth.layer.pipe(Layer.provide(providerHttp(world)))

/**
 * The real Google client, its token requests going to `world.oauthResponses` through the real OAuth client; only
 * Sign-In ID tokens ("valid:<email>") and the authorize URL are faked.
 */
export const fakeGoogle = (world: FakeWorld) =>
  Layer.effect(
    Google,
    Effect.map(Google, (real) =>
      Google.of({
        ...real,
        verifyIdToken: (token) =>
          token.startsWith("valid:")
            ? Effect.succeed({
                iss: "https://accounts.google.com" as const,
                aud: "ios-client.apps.googleusercontent.com",
                sub: `google-${token.slice(6)}`,
                email: token.slice(6),
                exp: 4102444800
              })
            : Effect.fail(new UpstreamFailure({ service: "Google", message: "bad token" })),
        authorizeUrl: ({ state, scopes }) =>
          Effect.succeed(`https://accounts.google.test/auth?state=${state}&scope=${scopes.join(",")}`),
        revoke: () => Effect.void
      })
    )
  ).pipe(Layer.provide(Google.layer), Layer.provide(fakeOAuth(world)), Layer.provide(providerHttp(world)))

export const fakeChatGpt = (world: FakeWorld) =>
  Layer.succeed(
    ChatGpt,
    ChatGpt.of({
      refresh: (credential) =>
        Effect.sync(() => {
          world.chatGptRefreshes++
          return {
            ...credential,
            accessToken: `chatgpt-access-${world.chatGptRefreshes + 1}`,
            refreshToken: `chatgpt-refresh-${world.chatGptRefreshes + 1}`,
            accessExpiresAtMs: 4102444800000
          }
        })
    })
  )

/** The services layer the platform normally builds, with every provider faked. */
export const fakeServices = (world: FakeWorld) =>
  Layer.mergeAll(
    fakeE2B(world),
    fakeEnvd(world),
    fakeDaemon(world),
    Apns.layerTest(world.pushes as Array<{ readonly token: string; readonly kind: string; readonly payload: unknown }>),
    fakeBrowserbase(world),
    fakeNamespace(world),
    fakeGoogle(world),
    OAuthProviders.layerTest(world.oauthConfigured),
    fakeOAuth(world),
    fakeChatGpt(world),
    Tokens.layer
  )

export const at = (iso: string) => DateTime.makeUnsafe(iso)
