/**
 * A throwaway Worker that runs a relay's real code in workerd, for an end-to-end check without deploying Dream:
 * the RelayDO's runtime (`relay/RelayLayer.ts`: the line, the Discord session, the outbox) over a Durable Object's
 * SQLite and alarm, opening its line with `Dialer.layerFetch`. Only the project is stood in for: instead of a
 * ProjectDO, its host hands events straight to a sandbox's dreamd with the ProjectDO's own client (`e2b/Daemon.ts`),
 * at a target the check sets, and logs in with a token from its env. `scripts/relay-probe.ts` bundles, deploys and
 * deletes it.
 *
 * Routes, all needing `?key=<PROBE_KEY>`, on the object named by `?relay=<id>`:
 *   POST /relay/rpc      RelayRpcs (Start, Stop, Restart, Status), as the ProjectDO calls a RelayDO
 *   POST /probe/start    the same as Start, with a `RelayConfig` as plain JSON
 *   GET  /probe/status   the same as Status, as plain JSON
 *   POST /probe/stop     the same as Stop
 *   POST /probe/target   where deliveries go: { sandboxId, domain, trafficAccessToken, daemonToken, port, path }
 *   GET  /probe/alerts   what the relay told the "agent"
 */
import { DurableObject } from "cloudflare:workers"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { HttpRpcSerialization } from "@dream/domain"
import { Context, Effect, Layer, Redacted, Schema, Scope } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { RpcServer } from "effect/rpc"
import { Daemon } from "../../src/e2b/Daemon.ts"
import { NativeAlarm } from "../../src/project/Alarm.ts"
import { Dialer } from "../../src/relay/Dialer.ts"
import { DiscordEndpoints } from "../../src/relay/Discord.ts"
import { RelayHandlers, relayLayer } from "../../src/relay/RelayLayer.ts"
import { RelayHost } from "../../src/relay/RelayHost.ts"
import { RelayConfig, RelayRpcPath, RelayRpcs, RelayStatus } from "../../src/relay/RelayRpcs.ts"
import { RelayRuntime } from "../../src/relay/Runtime.ts"

interface Env {
  readonly RELAY: DurableObjectNamespace
  readonly PROBE_KEY: string
  readonly DISCORD_BOT_TOKEN: string
  readonly DISCORD_API_URL: string
  readonly DISCORD_GATEWAY_HOST: string
}

const Target = Schema.Struct({
  sandboxId: Schema.String,
  domain: Schema.String,
  trafficAccessToken: Schema.String,
  daemonToken: Schema.String,
  port: Schema.Int,
  path: Schema.String
})
const decodeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(Target))
const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(RelayConfig)))
const encodeStatus = Schema.encodeSync(Schema.toCodecJson(RelayStatus))
const Alerts = Schema.fromJsonString(Schema.Array(Schema.String))
const decodeAlerts = (raw: string | undefined) => (raw === undefined ? [] : Schema.decodeUnknownSync(Alerts)(raw))

export class RelayProbe extends DurableObject<Env> {
  private readonly ready: Promise<{
    readonly handler: (request: Request) => Promise<Response>
    readonly relay: RelayRuntime["Service"]
  }>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    const kv = {
      get: (key: string) => Effect.promise(() => storage.get<string>(key)),
      put: (key: string, value: string) => Effect.promise(() => storage.put(key, value))
    }
    const host = Layer.effect(
      RelayHost,
      Effect.gen(function* () {
        const daemon = yield* Daemon
        return RelayHost.of({
          deliver: (_projectId, relayId, deliveries) =>
            Effect.gen(function* () {
              const raw = yield* kv.get("target")
              if (raw === undefined) return { delivered: 0, failure: { message: "no target set" } }
              const target = decodeTarget(raw)
              return yield* daemon.forwardRelay(
                {
                  sandboxId: target.sandboxId,
                  domain: target.domain,
                  envdAccessToken: "",
                  trafficAccessToken: target.trafficAccessToken
                },
                target.daemonToken,
                { relayId, port: target.port, path: target.path, deliveries }
              )
            }).pipe(
              Effect.catchTags({
                DaemonRestarting: () => Effect.succeed({ delivered: 0, failure: { message: "dreamd is restarting." } }),
                UpstreamFailure: (error) => Effect.succeed({ delivered: 0, failure: { message: error.message } })
              })
            ),
          credential: () =>
            Effect.succeed({
              key: Redacted.make(env.DISCORD_BOT_TOKEN),
              host: "discord.com",
              header: "Authorization",
              format: "Bot {key}"
            }),
          alert: (_projectId, _relayId, reason) =>
            Effect.gen(function* () {
              console.log(`alert: ${reason}`)
              const alerts = decodeAlerts(yield* kv.get("alerts"))
              yield* kv.put("alerts", Schema.encodeSync(Alerts)([...alerts, reason]))
            }),
          active: () => Effect.succeed(true)
        })
      })
    ).pipe(Layer.provide(Daemon.layer))
    const layer = RelayHandlers.pipe(
      Layer.provideMerge(
        relayLayer(storage as unknown as DurableObjectStorage, NativeAlarm.fromStorage(storage as never))
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          host,
          Dialer.layerFetch,
          DiscordEndpoints.layerFrom(env.DISCORD_API_URL, env.DISCORD_GATEWAY_HOST)
        )
      ),
      Layer.provideMerge(FetchHttpClient.layer)
    )
    this.ready = Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(layer, scope)
        const relay = Context.get(context, RelayRuntime)
        const httpEffect = yield* RpcServer.toHttpEffect(RelayRpcs).pipe(
          Effect.provide(Layer.mergeAll(Layer.succeedContext(context), HttpRpcSerialization)),
          Scope.provide(scope)
        )
        // As RelayDO does: an object that restarted picks its line up at once.
        Effect.runFork(relay.alarm)
        return { handler: HttpEffect.toWebHandler(httpEffect as never), relay }
      })
    )
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/probe/target" && request.method === "POST") {
      const text = await request.text()
      decodeTarget(text)
      await this.ctx.storage.put("target", text)
      return Response.json({ ok: true })
    }
    if (url.pathname === "/probe/alerts") {
      return Response.json(decodeAlerts(await this.ctx.storage.get<string>("alerts")))
    }
    const { handler, relay } = await this.ready
    if (url.pathname === "/probe/start" && request.method === "POST") {
      const config = decodeConfig(await request.text())
      return Response.json(encodeStatus(await Effect.runPromise(relay.start(config))))
    }
    if (url.pathname === "/probe/status") {
      const status = await Effect.runPromise(Effect.result(relay.status))
      return status._tag === "Success"
        ? Response.json(encodeStatus(status.success))
        : Response.json({ error: "no relay" }, { status: 404 })
    }
    if (url.pathname === "/probe/stop" && request.method === "POST") {
      await Effect.runPromise(relay.stop)
      return Response.json({ ok: true })
    }
    if (url.pathname === RelayRpcPath && request.method === "POST") return handler(request)
    return new Response("not found", { status: 404 })
  }

  override async alarm(): Promise<void> {
    const { relay } = await this.ready
    await Effect.runPromise(relay.alarm)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.searchParams.get("key") !== env.PROBE_KEY) return new Response("no", { status: 403 })
    const relay = url.searchParams.get("relay") ?? "rly_probe"
    return env.RELAY.get(env.RELAY.idFromName(relay)).fetch(request)
  }
}
