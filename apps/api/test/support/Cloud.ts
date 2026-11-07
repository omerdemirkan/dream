/**
 * The control plane in memory: the Worker's RPC servers, a ProjectDO per
 * project (each with its own SQLite), one D1, and fake providers. Clients
 * talk to it over real RPC (NDJSON over in-memory HTTP), like the phone and
 * dreamd do.
 */
import {
  AppAuth,
  AppRpcs,
  HttpRpcSerialization,
  type ProjectId,
  ProjectLiveRpcs,
  SandboxAuth,
  SandboxRpcs
} from "@dream/domain"
import type { R2Bucket } from "@cloudflare/workers-types"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { FetchHttpClient, Headers, HttpClientResponse, HttpEffect } from "effect/http"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import { RpcClient, RpcMiddleware, RpcServer } from "effect/rpc"
import { ApiConfig, type ApiConfigShape } from "../../src/Config.ts"
import { AppAuthServer, AuthedHandlers, PublicHandlers } from "../../src/http/AppHandlers.ts"
import { SandboxAuthServer as WorkerSandboxAuth, WorkerSandboxHandlers } from "../../src/http/SandboxHandlers.ts"
import { platformLayer } from "../../src/Platform.ts"
import { NativeAlarm } from "../../src/project/Alarm.ts"
import { DoRpcs, type ProjectFetch } from "../../src/project/Client.ts"
import { AgentHandlers, LiveHandlers, ProjectHandlers, SandboxAuthServer } from "../../src/project/Handlers.ts"
import { projectLayer } from "../../src/project/Layer.ts"
import { Scheduler } from "../../src/project/Scheduler.ts"
import type { SendEmailBinding } from "../../src/email/Mailer.ts"
import { workerLayer } from "../../src/WorkerLayer.ts"
import { ProjectClients } from "../../src/project/Client.ts"
import type { RelayFetch } from "../../src/relay/RelayClients.ts"
import { DiscordEndpoints } from "../../src/relay/Discord.ts"
import { RelayHandlers, relayLayer } from "../../src/relay/RelayLayer.ts"
import { RelayHost } from "../../src/relay/RelayHost.ts"
import { RelayRpcs } from "../../src/relay/RelayRpcs.ts"
import { FakeDiscord } from "./FakeDiscord.ts"
import { FakeWorld, fakeServices } from "./Fakes.ts"
import { discordRest, discordServer, FakeFeed, fakeDialer } from "./Lines.ts"
import { makeD1, makeDoStorage } from "./Sqlite.ts"

type WebHandler = (request: Request) => Promise<Response>

const toWeb = (httpEffect: Effect.Effect<any, any, any>): WebHandler => HttpEffect.toWebHandler(httpEffect as any)

/** An RpcClient layer whose transport is an in-memory web handler. */
const clientTransport = (handler: WebHandler, url: string) =>
  RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, ((input: RequestInfo | URL, init?: RequestInit) =>
        handler(new Request(input, init))) as typeof globalThis.fetch)
    ),
    Layer.provide(HttpRpcSerialization)
  )

const withBearer = (token: string | undefined) => (request: { readonly headers: Headers.Headers }) =>
  token === undefined
    ? request
    : { ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }

const appAuthClient = (token: () => string | undefined) =>
  RpcMiddleware.layerClient(AppAuth, ({ request, next }) => next({ ...request, ...withBearer(token())(request) }))

const sandboxAuthClient = (token: string) =>
  RpcMiddleware.layerClient(SandboxAuth, ({ request, next }) => next({ ...request, ...withBearer(token)(request) }))

export interface ProjectInstance {
  readonly handler: WebHandler
  readonly context: Context.Context<any>
  readonly storage: ReturnType<typeof makeDoStorage>
}

export const makeCloud = (
  configOverrides: Partial<ApiConfigShape> = {},
  options: {
    readonly updates?: R2Bucket | undefined
    readonly media?: R2Bucket | undefined
    readonly databasePath?: string
    /** A deployment that doesn't send email (no `send_email` binding). */
    readonly noEmail?: boolean
  } = {}
) =>
  Effect.gen(function* () {
    const world = new FakeWorld()
    const { d1, db } = makeD1(undefined, options.databasePath)
    const scope = yield* Scope.make()
    const config = ApiConfig.layerTest(configOverrides)
    const services = fakeServices(world)
    const instances = new Map<string, Promise<ProjectInstance>>()
    const relayInstances = new Map<string, Promise<ProjectInstance>>()
    /** Discord and a WebSocket feed, as relays reach them; the bot token Discord accepts is `discord-bot-token`. */
    const discord = new FakeDiscord({ token: "discord-bot-token", gatewayUrl: "wss://gateway.discord.test" })
    const feed = new FakeFeed()

    const fetchInto =
      (instance: (name: string) => Promise<ProjectInstance>) => (name: string, request: Parameters<ProjectFetch>[1]) =>
        Effect.gen(function* () {
          const found = yield* Effect.promise(() => instance(name))
          const web = yield* HttpServerRequest.toWeb(HttpServerRequest.fromClientRequest(request)).pipe(Effect.orDie)
          const response = yield* Effect.promise(() => found.handler(web))
          return HttpClientResponse.fromWeb(request, response)
        })
    const fetchProject: ProjectFetch = (projectId, request) =>
      fetchInto((id) => project(id as ProjectId))(projectId, request)
    const fetchRelay: RelayFetch = (relayId, request) => fetchInto(relay)(relayId, request)

    const platform = platformLayer({ d1, fetchProject, fetchRelay }, { services, config })

    /** A RelayDO per relay, on its own SQLite, reaching Discord and the feed through the fakes above. */
    const relay = (relayId: string): Promise<ProjectInstance> => {
      const existing = relayInstances.get(relayId)
      if (existing !== undefined) return existing
      const created = Effect.runPromise(
        Effect.gen(function* () {
          const storage = makeDoStorage()
          const layer = RelayHandlers.pipe(
            Layer.provideMerge(relayLayer(storage.storage, NativeAlarm.layerTest(storage.alarms))),
            Layer.provideMerge(
              Layer.mergeAll(
                RelayHost.layer.pipe(Layer.provide(ProjectClients.layer(fetchProject))),
                fakeDialer((url) =>
                  url.includes("discord.test")
                    ? discordServer(discord)
                    : url.startsWith("wss://feed.")
                      ? feed
                      : undefined
                ),
                DiscordEndpoints.layerFrom("https://discord.test/api/v10", "discord.test"),
                discordRest(discord)
              )
            )
          )
          const context = yield* Layer.buildWithScope(layer, scope)
          const httpEffect = yield* RpcServer.toHttpEffect(RelayRpcs).pipe(
            Effect.provide(Layer.mergeAll(Layer.succeedContext(context), HttpRpcSerialization)),
            Scope.provide(scope)
          )
          return { handler: toWeb(httpEffect), context, storage }
        })
      )
      relayInstances.set(relayId, created)
      return created
    }

    const project = (projectId: ProjectId): Promise<ProjectInstance> => {
      const existing = instances.get(projectId)
      if (existing !== undefined) return existing
      const created = Effect.runPromise(
        Effect.gen(function* () {
          const storage = makeDoStorage()
          const layer = Layer.mergeAll(ProjectHandlers, AgentHandlers, SandboxAuthServer, LiveHandlers).pipe(
            Layer.provideMerge(projectLayer(storage.storage, NativeAlarm.layerTest(storage.alarms))),
            Layer.provideMerge(platform)
          )
          const context = yield* Layer.buildWithScope(layer, scope)
          const httpEffect = yield* RpcServer.toHttpEffect(DoRpcs.merge(ProjectLiveRpcs)).pipe(
            Effect.provide(Layer.mergeAll(Layer.succeedContext(context), HttpRpcSerialization)),
            Scope.provide(scope)
          )
          return { handler: toWeb(httpEffect), context, storage }
        })
      )
      instances.set(projectId, created)
      return created
    }

    /** What Cloudflare Email Service was asked to send; set `failWith` to make it throw with that code. */
    const mail: {
      readonly sent: Array<Parameters<SendEmailBinding["send"]>[0]>
      failWith: string | undefined
    } = { sent: [], failWith: undefined }
    const email: SendEmailBinding = {
      send: async (message) => {
        if (mail.failWith !== undefined)
          throw Object.assign(new Error(`failed: ${message.text}`), { code: mail.failWith })
        mail.sent.push(message)
        return { messageId: `mail-${mail.sent.length}` }
      }
    }

    const worker = workerLayer(
      {
        email: options.noEmail === true ? undefined : email,
        d1,
        r2: options.media,
        updates: options.updates,
        fetchProject,
        forwardLive: () => Effect.die("no live in tests")
      },
      { services, config }
    )
    const workerContext = yield* Layer.buildWithScope(worker, scope)

    const appHandler = toWeb(
      yield* RpcServer.toHttpEffect(AppRpcs).pipe(
        Effect.provide(
          Layer.mergeAll(PublicHandlers, AuthedHandlers, AppAuthServer, HttpRpcSerialization).pipe(
            Layer.provide(Layer.succeedContext(workerContext))
          )
        ),
        Scope.provide(scope)
      )
    )
    const sandboxHandler = toWeb(
      yield* RpcServer.toHttpEffect(SandboxRpcs).pipe(
        Effect.provide(
          Layer.mergeAll(WorkerSandboxHandlers, WorkerSandboxAuth, HttpRpcSerialization).pipe(
            Layer.provide(Layer.succeedContext(workerContext))
          )
        ),
        Scope.provide(scope)
      )
    )

    /** The phone's client, signed in as whoever `session.token` names. */
    const session: { token: string | undefined } = { token: undefined }
    const phone = yield* RpcClient.make(AppRpcs).pipe(
      Effect.provide(
        Layer.mergeAll(
          clientTransport(appHandler, "https://api.dream.test/rpc"),
          appAuthClient(() => session.token)
        )
      ),
      Scope.provide(scope)
    )

    /** dreamd's client for one project's token. */
    const sandbox = (projectToken: string) =>
      RpcClient.make(SandboxRpcs).pipe(
        Effect.provide(
          Layer.mergeAll(
            clientTransport(sandboxHandler, "https://api.dream.test/sandbox/rpc"),
            sandboxAuthClient(projectToken)
          )
        ),
        Scope.provide(scope)
      )

    /** A phone subscribed to a project's live stream (over HTTP here; the DO serves it on its socket). */
    const live = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const instance = yield* Effect.promise(() => project(projectId))
        return yield* RpcClient.make(ProjectLiveRpcs).pipe(
          Effect.provide(clientTransport(instance.handler, "https://project/internal/rpc")),
          Scope.provide(scope)
        )
      })

    /** Fires a project's alarm, as workerd would. */
    const alarm = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const instance = yield* Effect.promise(() => project(projectId))
        yield* Context.get(instance.context, Scheduler).run
      })

    const close = Scope.close(scope, Exit.void)

    return {
      world,
      mail,
      db,
      d1,
      phone,
      session,
      sandbox,
      live,
      alarm,
      project,
      relay,
      discord,
      feed,
      workerContext,
      /** The Worker's HTTP handlers, for serving a real dreamd (`scripts/notify-standin.ts`). */
      appHandler,
      sandboxHandler,
      close
    }
  })
