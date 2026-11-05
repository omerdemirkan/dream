/**
 * The Worker's request handling. `api.<domain>` (configurable) serves the
 * RPC endpoints, the live WebSocket hand-off, media and OAuth callbacks;
 * every other `*.<domain>` host is a published app.
 */
import { AppRpcs, HttpRpcSerialization, ProjectId, Routes, SandboxRpcs } from "@dream/domain"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { RpcServer } from "effect/rpc"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { Access } from "../integrations/Access.ts"
import { ProjectClients } from "../project/Client.ts"
import { LivePath } from "../project/ProjectRpcs.ts"
import { timingSafeEqual } from "../lib/Bytes.ts"
import { AppAuthServer, AuthedHandlers, bearer, PublicHandlers } from "./AppHandlers.ts"
import { connectProvider, showConnectPage, submitConnectPage } from "./ConnectPage.ts"
import { gateway } from "./Gateway.ts"
import { downloadMedia, uploadMedia } from "./Media.ts"
import { SandboxAuthServer, WorkerSandboxHandlers } from "./SandboxHandlers.ts"

export class LiveForwarder extends Context.Service<
  LiveForwarder,
  {
    readonly forward: (projectId: ProjectId, request: Request) => Effect.Effect<HttpServerResponse.HttpServerResponse>
  }
>()("@dream/api/LiveForwarder") {}

/** Hands a phone's WebSocket upgrade to the project's DO, at the path only its live server answers. */
export const forwardLive = (projectId: ProjectId, raw: Request) =>
  Effect.gen(function* () {
    const live = yield* LiveForwarder
    const url = new URL(raw.url)
    url.pathname = LivePath
    url.search = ""
    return yield* live.forward(projectId, new Request(url.toString(), raw))
  })

const appRpc = Effect.gen(function* () {
  const handler = yield* RpcServer.toHttpEffect(AppRpcs).pipe(
    Effect.provide(Layer.mergeAll(PublicHandlers, AuthedHandlers, AppAuthServer, HttpRpcSerialization))
  )
  return yield* handler
})

const sandboxRpc = Effect.gen(function* () {
  const handler = yield* RpcServer.toHttpEffect(SandboxRpcs).pipe(
    Effect.provide(Layer.mergeAll(WorkerSandboxHandlers, SandboxAuthServer, HttpRpcSerialization))
  )
  return yield* handler
})

export const route = (raw: Request) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const request = yield* HttpServerRequest
    const url = new URL(raw.url)
    const host = url.hostname.toLowerCase()

    if (host !== config.apiHost) {
      if (host.endsWith(`.${config.domain}`)) return yield* gateway(host, raw)
      return HttpServerResponse.text("Not found", { status: 404 })
    }

    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    if (path === "/health") return HttpServerResponse.text("ok")
    if (path === Routes.app && request.method === "POST") return yield* appRpc
    if (path === Routes.sandbox && request.method === "POST") return yield* sandboxRpc

    const live = /^\/projects\/([^/]+)\/live$/.exec(path)
    if (live !== null) {
      const tokens = yield* Tokens
      const ticket = url.searchParams.get("ticket")
      const projectId = Schema.decodeUnknownOption(ProjectId)(decodeURIComponent(live[1]!))
      if (ticket === null || Option.isNone(projectId)) return HttpServerResponse.text("Missing ticket", { status: 401 })
      const claims = yield* tokens.verifyLiveTicket(ticket).pipe(Effect.option)
      if (Option.isNone(claims) || claims.value.projectId !== projectId.value) {
        return HttpServerResponse.text("Invalid or expired ticket", { status: 401 })
      }
      return yield* forwardLive(projectId.value, raw)
    }

    const upload = /^\/media\/([^/]+)\/upload$/.exec(path)
    if (upload !== null && request.method === "PUT") return yield* uploadMedia(request, upload[1]!, raw)

    const media = /^\/media\/([^/]+)$/.exec(path)
    if (media !== null && (request.method === "GET" || request.method === "HEAD")) {
      const tokens = yield* Tokens
      const token = Option.orElse(bearer(request.headers), () => Option.fromNullishOr(url.searchParams.get("token")))
      if (Option.isNone(token)) return HttpServerResponse.text("Sign in first", { status: 401 })
      const session = yield* tokens.verifySession(token.value).pipe(Effect.option)
      if (Option.isNone(session)) return HttpServerResponse.text("Session expired", { status: 401 })
      return yield* downloadMedia(request, media[1]!, session.value.userId)
    }

    // Operator tool (e2e cleanup): archive a project. Needs the DEV_LOGIN_SECRET in `x-dream-dev-secret`.
    const archive = /^\/admin\/projects\/([^/]+)\/archive$/.exec(path)
    if (archive !== null && request.method === "POST") {
      const secret = request.headers["x-dream-dev-secret"]
      const expected = Option.map(config.devLoginSecret, Redacted.value)
      if (secret === undefined || Option.isNone(expected) || !timingSafeEqual(secret, expected.value)) {
        return HttpServerResponse.text("Forbidden", { status: 403 })
      }
      const projectId = Schema.decodeUnknownOption(ProjectId)(archive[1])
      if (Option.isNone(projectId)) return HttpServerResponse.text("Bad project id", { status: 400 })
      const clients = yield* ProjectClients
      yield* clients.use(projectId.value, (client) => client.Archive())
      return HttpServerResponse.text("archived")
    }

    // The one-time token page from `CreateConnectLink`. Its body (the token) is never logged.
    const connect = /^\/connect\/([^/]+)$/.exec(path)
    if (connect !== null) {
      const provider = connectProvider(connect[1]!)
      if (Option.isSome(provider) && request.method === "GET")
        return yield* showConnectPage(provider.value, url.searchParams.get("t"))
      if (Option.isSome(provider) && request.method === "POST") return yield* submitConnectPage(provider.value)
    }

    if (path === Routes.googleOAuthCallback && request.method === "GET") {
      const access = yield* Access
      const back = (params: Record<string, string>) =>
        HttpServerResponse.redirect(`${config.appScheme}://oauth/google?${new URLSearchParams(params).toString()}`, {
          status: 302
        })
      const state = url.searchParams.get("state")
      const code = url.searchParams.get("code")
      const error = url.searchParams.get("error")
      if (state === null || code === null || error !== null)
        return back({ status: "error", error: error ?? "cancelled" })
      const result = yield* access.finishGoogle(state, code).pipe(Effect.result)
      return result._tag === "Success"
        ? back({ status: "connected", projectId: result.success.projectId, messageId: result.success.messageId })
        : back({ status: "error", error: result.failure.message })
    }

    return HttpServerResponse.text("Not found", { status: 404 })
  })
