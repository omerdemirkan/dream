/** Shared test values: a config pointing at a temp dir, event builders, a fake API and a daemon client. */
import { mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AgentEvent,
  CurrentProject,
  DaemonAuth,
  DaemonEnv,
  DaemonRpcs,
  type EventId,
  HttpRpcSerialization,
  type MessageId,
  type ProjectId,
  Routes,
  SandboxAuth,
  SandboxRpcs,
  Unauthorized,
  type UserId,
  type WakeId
} from "@dream/domain"
import * as Fixtures from "@dream/domain/fixtures"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { DateTime, Effect, Layer, Option, Ref } from "effect"
import { FetchHttpClient, Headers, HttpRouter } from "effect/http"
import { RpcClient, RpcMiddleware, RpcServer } from "effect/rpc"
import { PageCheck } from "../src/cli/PageCheck.ts"
import { DreamdConfig } from "../src/Config.ts"

export const tempDir = (prefix = "dreamd-test-") => mkdtempSync(join(tmpdir(), prefix))

export const configRecord = (dir: string, overrides: Record<string, string> = {}): Record<string, string> => ({
  HOME: dir,
  DREAM_STATE_DIR: join(dir, "state"),
  DREAM_WORKDIR: join(dir, "project"),
  [DaemonEnv.apiUrl]: "http://api.test",
  [DaemonEnv.projectId]: "prj_test",
  [DaemonEnv.projectToken]: "project-token",
  [DaemonEnv.daemonToken]: "daemon-token",
  [DaemonEnv.harness]: "claude-code",
  [DaemonEnv.socket]: join(dir, "dreamd.sock"),
  ...overrides
})

/** Config and Node services for a test rooted at `dir`. */
export const baseLayer = (dir: string, overrides: Record<string, string> = {}) =>
  Layer.mergeAll(DreamdConfig.layerFromRecord(configRecord(dir, overrides)), NodeServices.layer)

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 4, 22, minute))

export const userMessage = (n: number, text = `message ${n}`) =>
  AgentEvent.cases.UserMessage.make({
    id: `evt_${n}` as EventId,
    at: at(n),
    messageId: `msg_${n}` as MessageId,
    text
  })

export const wakeWithCommand = (n: number, command: string) =>
  AgentEvent.cases.WakeDue.make({
    id: `evt_${n}` as EventId,
    at: at(n),
    wakeId: `wak_${n}` as WakeId,
    why: "check the scraper",
    run: { command }
  })

export const wakeWithTask = (n: number, brief: string) =>
  AgentEvent.cases.WakeDue.make({
    id: `evt_${n}` as EventId,
    at: at(n),
    wakeId: `wak_${n}` as WakeId,
    why: "weekly episode",
    task: { brief, model: "sonnet", effort: "medium" }
  })

export const usageReset = (n: number) =>
  AgentEvent.cases.UsageReset.make({ id: `evt_${n}` as EventId, at: at(n), window: "fiveHour" })

export const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })

/** A Worker that answers the RPCs these tests use and records what it was sent, with which token. */
export const fakeApi = (calls: Ref.Ref<ReadonlyArray<string>>, port: number) => {
  const record = (call: string) => Ref.update(calls, (all) => [...all, call])
  const handlers = SandboxRpcs.toLayer(
    new Proxy({} as never, {
      get: (_, tag: string) => (payload: unknown) =>
        Effect.gen(function* () {
          yield* record(`${tag} ${JSON.stringify(payload)}`)
          if (tag === "SendMessage") return Fixtures.liftLogUpdate
          if (tag === "Publish") return { url: "https://lift-log-x7k2.dream.test" }
          if (tag === "ListRelays") return []
          if (tag === "ScheduleWake") {
            return { id: "wak_test", ...(payload as object), createdAt: DateTime.makeUnsafe("2026-11-06T20:00:00Z") }
          }
          if (tag === "AddRelay") {
            const { source, target } = payload as { source: unknown; target: unknown }
            return {
              id: "rly_test",
              source,
              target,
              createdAt: DateTime.makeUnsafe("2026-11-06T20:00:00Z"),
              state: "connecting",
              waiting: 0,
              delivered: 0,
              dropped: 0,
              problems: []
            }
          }
          return undefined
        })
    })
  )
  const auth = Layer.succeed(SandboxAuth, (effect, { headers }) =>
    Option.getOrUndefined(Headers.get(headers, "authorization")) === "Bearer project-token"
      ? Effect.provideService(effect, CurrentProject, {
          projectId: "prj_test" as ProjectId,
          userId: "usr_test" as UserId
        })
      : Effect.fail(new Unauthorized({ message: "bad project token" }))
  )
  return HttpRouter.serve(
    RpcServer.layerHttp({ group: SandboxRpcs, path: Routes.sandbox, protocol: "http" }).pipe(
      Layer.provide([handlers, auth, HttpRpcSerialization])
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(Layer.provide(NodeHttpServer.layer(() => createServer(), { port, host: "127.0.0.1" })))
}

export const daemonClient = (port: number, token: string) =>
  RpcClient.make(DaemonRpcs).pipe(
    Effect.provide(
      Layer.mergeAll(
        RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}${Routes.daemon}` }).pipe(
          Layer.provide([FetchHttpClient.layer, HttpRpcSerialization])
        ),
        RpcMiddleware.layerClient(DaemonAuth, ({ request, next }) =>
          next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) })
        )
      )
    )
  )

/** For tests where nothing should load a published URL. */
export const noPageChecks = PageCheck.layerTest(Effect.die("no page checks here"))
