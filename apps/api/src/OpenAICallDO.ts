/**
 * One Durable Object per WebRTC call or GPT-Live session started through Dream's OpenAI gateway, named by its id:
 * it attaches to the call as a sideband (`wss://…/v1/realtime?call_id=rtc_…`, or a Live session's `…/attach`) with
 * the key the call was made with, and meters what OpenAI reports there until the call ends (`openai/Realtime.ts`).
 * The gateway can't see a WebRTC call's media, which goes between the browser and OpenAI directly.
 *
 * Only the Worker calls it, at `/attach`, and it attaches with Dream's key. The call is held in memory, never stored:
 * an object that restarts mid-call (a deploy) stops metering that call.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect, Layer, Option, Schema, Scope } from "effect"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { ApiConfig } from "./Config.ts"
import { MeterD1 } from "./metering/MeterD1.ts"
import { D1Client } from "@effect/sql-d1"
import type { Socket } from "./openai/Realtime.ts"
import { OpenAIUpstream, SidebandRequest } from "./openai/Runtime.ts"
import { attachSideband, SidebandPath } from "./openai/Sideband.ts"
import { Database } from "./Resources.ts"

export { SidebandPath }

export default class OpenAICallDO extends Cloudflare.DurableObject<OpenAICallDO>()(
  "OpenAICallDO",
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(Database)

    return Effect.gen(function* () {
      const d1 = yield* db.raw
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        Layer.mergeAll(
          OpenAIUpstream.layer,
          MeterD1.pipe(Layer.provide(D1Client.layer({ db: d1 as never }).pipe(Layer.orDie)))
        ).pipe(Layer.provideMerge(ApiConfig.layer)),
        scope
      )
      let attached = Option.none<Socket>()

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest
          const path = new URL(request.url, "https://call").pathname.replace(/\/+$/, "")
          if (path !== SidebandPath || request.method !== "POST")
            return HttpServerResponse.text("Not found", { status: 404 })
          if (Option.isSome(attached)) return HttpServerResponse.text("already attached", { status: 200 })
          const body = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(SidebandRequest)),
            Effect.option
          )
          if (Option.isNone(body)) return HttpServerResponse.text("Bad request", { status: 400 })
          return yield* attachSideband(body.value).pipe(
            Effect.provide(Layer.succeedContext(context)),
            Effect.map((socket) => {
              attached = Option.some(socket)
              return HttpServerResponse.text("attached", { status: 202 })
            }),
            Effect.catchCause((cause) =>
              Effect.logWarning("openai sideband: couldn't attach", cause).pipe(
                Effect.as(HttpServerResponse.text("Couldn't attach", { status: 502 }))
              )
            )
          )
        })
      }
    })
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))
) {}
