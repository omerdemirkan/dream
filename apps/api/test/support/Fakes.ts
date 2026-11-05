/**
 * Fakes for every external service the control plane calls. Each records
 * what it was asked so tests can assert on it.
 */
import { UpstreamFailure } from "@dream/domain"
import { DateTime, Effect, Layer, Option, Stream } from "effect"
import { Browserbase } from "../../src/brokers/Browserbase.ts"
import { Namespace } from "../../src/brokers/Namespace.ts"
import { ChatGpt } from "../../src/connect/ChatGpt.ts"
import { Daemon } from "../../src/e2b/Daemon.ts"
import { E2B, type NetworkRules, type SandboxAccess, SandboxGone } from "../../src/e2b/E2B.ts"
import { Envd, type ProcessOutput } from "../../src/e2b/Envd.ts"
import { Google } from "../../src/integrations/Google.ts"
import { Apns } from "../../src/push/Apns.ts"
import { Tokens } from "../../src/auth/Tokens.ts"

export interface FakeSandbox {
  readonly access: SandboxAccess
  readonly template: string
  state: "running" | "paused" | "killed"
  rules: NetworkRules
  timeoutSeconds: number
  readonly files: Map<string, string>
  readonly metadata: Readonly<Record<string, string>>
}

export class FakeWorld {
  readonly sandboxes = new Map<string, FakeSandbox>()
  readonly delivered: Array<{ sandboxId: string; events: ReadonlyArray<unknown>; timeZone: string | undefined }> = []
  readonly pushes: Array<{ readonly token: string; readonly kind: string; readonly payload: unknown }> = []
  readonly processes: Array<{ sandboxId: string; command: string; pty: boolean }> = []
  readonly inputs: Array<{ sandboxId: string; pid: number; text: string }> = []
  readonly browserSessions = new Map<string, { status: string; startedAt: string; endedAt?: string }>()
  readonly macs = new Map<string, { status: string }>()
  daemonHealthy = true
  deliverFails = false
  /** What a started process prints, by a substring of its command. */
  readonly scripts = new Map<string, ReadonlyArray<ProcessOutput>>()
  /** What a reattached process prints after input. */
  attachOutput: ReadonlyArray<ProcessOutput> = []
  googleRefreshes = 0
  chatGptRefreshes = 0
  private counter = 0
  nextId = (prefix: string) => `${prefix}${++this.counter}`
}

export const fakeE2B = (world: FakeWorld) =>
  Layer.succeed(
    E2B,
    E2B.of({
      create: (options) =>
        Effect.sync(() => {
          const sandboxId = world.nextId("sbx")
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
            rules: options.rules,
            timeoutSeconds: options.timeoutSeconds,
            files: new Map(),
            metadata: options.metadata
          })
          return access
        }),
      connect: (sandboxId, timeoutSeconds) => {
        const sandbox = world.sandboxes.get(sandboxId)
        if (sandbox === undefined || sandbox.state === "killed") return Effect.fail(new SandboxGone({ sandboxId }))
        sandbox.state = "running"
        sandbox.timeoutSeconds = timeoutSeconds
        return Effect.succeed(sandbox.access)
      },
      info: (sandboxId) =>
        Effect.sync(() => {
          const sandbox = world.sandboxes.get(sandboxId)
          return sandbox === undefined ? Option.none() : Option.some({ sandboxID: sandboxId, state: sandbox.state })
        }),
      setTimeout: (sandboxId, timeoutSeconds) => {
        const sandbox = world.sandboxes.get(sandboxId)
        if (sandbox === undefined) return Effect.fail(new SandboxGone({ sandboxId }))
        sandbox.timeoutSeconds = timeoutSeconds
        return Effect.void
      },
      updateRules: (sandboxId, rules) =>
        Effect.sync(() => {
          const sandbox = world.sandboxes.get(sandboxId)
          if (sandbox === undefined || sandbox.state !== "running") return false
          sandbox.rules = rules
          return true
        }),
      pause: (sandboxId) =>
        Effect.sync(() => {
          const sandbox = world.sandboxes.get(sandboxId)
          if (sandbox !== undefined) sandbox.state = "paused"
        }),
      kill: (sandboxId) =>
        Effect.sync(() => {
          const sandbox = world.sandboxes.get(sandboxId)
          if (sandbox !== undefined) sandbox.state = "killed"
        })
    })
  )

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

export const fakeDaemon = (world: FakeWorld) =>
  Layer.succeed(
    Daemon,
    Daemon.of({
      deliver: (sandbox, _token, events, timeZone) =>
        world.deliverFails
          ? Effect.fail(new UpstreamFailure({ service: "dreamd", message: "down" }))
          : Effect.sync(() => {
              world.delivered.push({ sandboxId: sandbox.sandboxId, events, timeZone })
              return events.map((event) => event.id)
            }),
      health: () =>
        world.daemonHealthy
          ? Effect.succeed({ version: "test", turn: "idle" as const, queued: 0 })
          : Effect.fail(new UpstreamFailure({ service: "dreamd", message: "down" }))
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

export const fakeGoogle = (world: FakeWorld) =>
  Layer.succeed(
    Google,
    Google.of({
      verifyIdToken: (token) =>
        token.startsWith("valid:")
          ? Effect.succeed({
              iss: "https://accounts.google.com" as const,
              aud: "ios-client.apps.googleusercontent.com",
              sub: `google-${token.slice(6)}`,
              email: token.slice(6),
              exp: 4102444800
            })
          : (Effect.fail(new UpstreamFailure({ service: "Google", message: "bad token" })) as never),
      authorizeUrl: ({ state, scopes }) =>
        Effect.succeed(`https://accounts.google.test/auth?state=${state}&scope=${scopes.join(",")}`),
      exchangeCode: () =>
        Effect.succeed({
          access_token: "google-access-1",
          expires_in: 3600,
          refresh_token: "google-refresh-1",
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          email: "omer@example.com"
        }),
      refresh: () =>
        Effect.sync(() => {
          world.googleRefreshes++
          return { access_token: `google-access-${world.googleRefreshes + 1}`, expires_in: 3600 }
        }),
      revoke: () => Effect.void
    })
  )

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
    fakeChatGpt(world),
    Tokens.layer
  )

export const at = (iso: string) => DateTime.makeUnsafe(iso)
