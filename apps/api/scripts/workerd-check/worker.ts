/**
 * The AI gateway inside workerd, with in-memory stand-ins for D1, for `run.ts`: the real `openaiGateway`,
 * `OpenAIUpstream.layer` (outbound WebSocket upgrades, `WebSocketPair` and the 101), `waitUntil` while a socket is
 * open, and `attachSideband` in a Durable Object, against fake-openai. Bundled by `bun build`; never deployed.
 */
import { Effect, Layer, Option } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Tokens } from "../../src/auth/Tokens.ts"
import { ApiConfig } from "../../src/Config.ts"
import { Projects } from "../../src/db/Projects.ts"
import { Meter, type MeterEvent } from "../../src/metering/Meter.ts"
import { ClientSecrets } from "../../src/openai/ClientSecrets.ts"
import { openaiGateway } from "../../src/openai/Gateway.ts"
import { OpenAIObjects } from "../../src/openai/Objects.ts"
import { AfterResponse, CallSideband, OpenAIUpstream, type SidebandRequest } from "../../src/openai/Runtime.ts"
import { attachSideband } from "../../src/openai/Sideband.ts"

declare const FAKE_URL: string

const events: Array<MeterEvent> = []
const owners = new Map<string, string>()

const config = ApiConfig.layerTest({
  aiGatewayEnabled: true,
  openaiApiUrl: FAKE_URL
})
const meter = Layer.succeed(Meter, Meter.of({ record: (found) => Effect.sync(() => void events.push(...found)) }))
const objects = Layer.succeed(
  OpenAIObjects,
  OpenAIObjects.of({
    record: (row) => Effect.sync(() => void owners.set(row.id, row.projectId)),
    projectOf: (id) => Effect.sync(() => Option.fromNullishOr(owners.get(id))),
    markMetered: () => Effect.void,
    giveUp: () => Effect.void,
    checkLater: () => Effect.void,
    due: () => Effect.succeed([]),
    prune: () => Effect.void
  })
)
// The gateway only asks who owns the project.
const projects = Layer.succeed(Projects, {
  find: () => Effect.succeed(Option.some({ ownerId: "usr_check" }))
} as unknown as Projects["Service"])

interface Env {
  readonly CALLS: { readonly getByName: (name: string) => { fetch: (request: Request) => Promise<Response> } }
}
interface Ctx {
  readonly waitUntil: (promise: Promise<unknown>) => void
}

const base = (ctx: Ctx, env: Env) =>
  Layer.mergeAll(
    Tokens.layer,
    ClientSecrets.layer,
    OpenAIUpstream.layer,
    meter,
    objects,
    projects,
    Layer.succeed(
      AfterResponse,
      AfterResponse.of({ run: (effect) => Effect.sync(() => ctx.waitUntil(Effect.runPromise(effect))) })
    ),
    Layer.succeed(
      CallSideband,
      CallSideband.of({
        attach: (request) =>
          Effect.promise(() =>
            env.CALLS.getByName(request.id).fetch(
              new Request("https://call/attach", { method: "POST", body: JSON.stringify(request) })
            )
          ).pipe(Effect.asVoid)
      })
    )
  ).pipe(Layer.provideMerge(config))

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/_events") return Response.json(events)
    const response = await Effect.runPromise(
      openaiGateway(request).pipe(Effect.provide(base(ctx, env)), Effect.map(HttpServerResponse.toWeb))
    )
    return response
  }
}

export class CallDO {
  attached = false
  async fetch(request: Request): Promise<Response> {
    if (this.attached) return new Response("already")
    const body = (await request.json()) as SidebandRequest
    await Effect.runPromise(
      attachSideband(body).pipe(
        Effect.provide(Layer.mergeAll(OpenAIUpstream.layer, meter).pipe(Layer.provideMerge(config)))
      )
    )
    this.attached = true
    return new Response("attached", { status: 202 })
  }
}
