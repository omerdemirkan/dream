/**
 * The Worker's request handling. `api.<domain>` (configurable) serves the
 * RPC endpoints, the live WebSocket hand-off, media and OAuth callbacks;
 * every other `*.<domain>` host is a published app.
 */
import { AppRpcs, HttpRpcSerialization, ProjectId, Routes, SandboxRpcs, TestflightBuilds } from "@dream/domain"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { RpcServer } from "effect/rpc"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { Access } from "../integrations/Access.ts"
import { deleteProject } from "../project/Deletion.ts"
import { LivePath } from "../project/ProjectRpcs.ts"
import { timingSafeEqual } from "../lib/Bytes.ts"
import { AppAuthServer, AuthedHandlers, bearer, PublicHandlers } from "./AppHandlers.ts"
import { desktopLinkOfState } from "../desktop/DesktopAccess.ts"
import { connectProvider, showConnectPage, submitConnectPage } from "./ConnectPage.ts"
import {
  desktopSignInResult,
  openDesktopLink,
  showDesktopAccess,
  showDesktopLanding,
  startDesktopSignIn,
  submitDesktopAccess
} from "./DesktopPage.ts"
import { gateway } from "./Gateway.ts"
import { readClientErrors, receiveClientErrors } from "./ClientErrors.ts"
import { macActivity } from "./MacActivity.ts"
import { receiveE2bWebhook, registerE2bWebhook } from "./Metering.ts"
import { OpenAIGateway } from "@dream/domain"
import { devCredential, devEvents } from "../openai/Dev.ts"
import { openaiGateway } from "../openai/Gateway.ts"
import { downloadAttachmentForSandbox, downloadMedia, uploadAttachment, uploadMedia } from "./Media.ts"
import { homePage, privacyPage } from "./PublicPages.ts"
import { SandboxAuthServer, WorkerSandboxHandlers } from "./SandboxHandlers.ts"
import { grantAscKey, releaseAscKey, storeSigningIdentity } from "./Testflight.ts"
import { readTestflightBuilds } from "./TestflightBuilds.ts"
import {
  answered,
  ensureSigningKey,
  isPublisher,
  publishUpdate,
  rollbackUpdate,
  serveAsset,
  serveCertificate,
  serveManifest,
  updatesStatus,
  uploadAsset
} from "./Updates.ts"

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
      // Published apps' hosts always have a dash, so this one is never an app's.
      if (host === OpenAIGateway.host(config.domain)) return yield* openaiGateway(raw)
      if (host.endsWith(`.${config.domain}`)) return yield* gateway(host, raw)
      return HttpServerResponse.text("Not found", { status: 404 })
    }

    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    if (path === "/health") return HttpServerResponse.text("ok")
    // The public pages Google's consent screen links to.
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/") return homePage()
      if (path === "/privacy") return privacyPage()
    }
    if (path === Routes.app && request.method === "POST") return yield* appRpc
    if (path === Routes.sandbox && request.method === "POST") return yield* sandboxRpc
    if (path === Routes.e2bWebhook && request.method === "POST") return yield* receiveE2bWebhook
    if (path === Routes.clientErrors && request.method === "POST") return yield* receiveClientErrors(request)

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

    const attachmentUpload = /^\/attachments\/([^/]+)\/upload$/.exec(path)
    if (attachmentUpload !== null && request.method === "PUT") {
      return yield* uploadAttachment(request, attachmentUpload[1]!, raw)
    }

    const sandboxAttachment = /^\/sandbox\/attachments\/([^/]+)$/.exec(path)
    if (sandboxAttachment !== null && request.method === "GET") {
      const tokens = yield* Tokens
      const token = bearer(request.headers)
      const project = Option.isNone(token)
        ? Option.none()
        : yield* tokens.verifyProject(token.value).pipe(Effect.option)
      if (Option.isNone(project)) return HttpServerResponse.text("Invalid project token", { status: 401 })
      return yield* downloadAttachmentForSandbox(sandboxAttachment[1]!, project.value.projectId)
    }

    const media = /^\/media\/([^/]+)$/.exec(path)
    if (media !== null && (request.method === "GET" || request.method === "HEAD")) {
      const tokens = yield* Tokens
      const token = Option.orElse(bearer(request.headers), () => Option.fromNullishOr(url.searchParams.get("token")))
      if (Option.isNone(token)) return HttpServerResponse.text("Sign in first", { status: 401 })
      const session = yield* tokens.verifySession(token.value).pipe(Effect.option)
      if (Option.isNone(session)) return HttpServerResponse.text("Session expired", { status: 401 })
      return yield* downloadMedia(request, media[1]!, session.value.userId)
    }

    // Over-the-air updates of the app (Updates.ts): the Expo Updates protocol, and the operator's publishing routes.
    const reading = request.method === "GET" || request.method === "HEAD"
    if (path === Routes.updatesManifest && request.method === "GET") return yield* answered(serveManifest(request))
    const updateAsset = /^\/updates\/assets\/([^/]+)$/.exec(path)
    if (updateAsset !== null && reading) return yield* answered(serveAsset(request, updateAsset[1]!))
    if (path === Routes.updatesCertificate && reading) return yield* answered(serveCertificate)
    if (path.startsWith("/admin/updates/")) {
      if (!(yield* isPublisher(request))) return HttpServerResponse.text("Forbidden", { status: 403 })
      const upload = /^\/admin\/updates\/assets\/([^/]+)$/.exec(path)
      if (upload !== null && (request.method === "PUT" || request.method === "HEAD"))
        return yield* answered(uploadAsset(request, upload[1]!, raw))
      if (path === Routes.updatesPublish && request.method === "POST") return yield* answered(publishUpdate(request))
      if (path === Routes.updatesRollback && request.method === "POST") return yield* answered(rollbackUpdate(request))
      if (path === Routes.updatesStatus && request.method === "GET") return yield* answered(updatesStatus(url))
      if (path === Routes.updatesSigningKey && request.method === "POST") return yield* answered(ensureSigningKey)
      return HttpServerResponse.text("Not found", { status: 404 })
    }

    // Operator tools need the DEV_LOGIN_SECRET in `x-dream-dev-secret`.
    const operator = () => {
      const secret = request.headers["x-dream-dev-secret"]
      const expected = Option.map(config.devLoginSecret, Redacted.value)
      return secret !== undefined && Option.isSome(expected) && timingSafeEqual(secret, expected.value)
    }

    // Dream's own TestFlight builds: the operator grants a Namespace build Mac, which then fetches the key.
    if (path === Routes.testflightGrant && request.method === "POST") {
      if (!operator()) return HttpServerResponse.text("Forbidden", { status: 403 })
      const body = yield* request.json.pipe(Effect.orElseSucceed(() => null))
      return yield* grantAscKey(body).pipe(
        Effect.map((instanceId) => HttpServerResponse.jsonUnsafe({ granted: instanceId })),
        Effect.catchTag("TestflightDenied", (e) => Effect.succeed(HttpServerResponse.text(e.reason, { status: 400 })))
      )
    }
    // Checks of the live AI gateway that run no agent: a dev pseudo-project's credential, and what it was metered.
    if (path === Routes.openaiDevCredential && request.method === "POST") {
      if (!operator()) return HttpServerResponse.text("Forbidden", { status: 403 })
      return yield* devCredential(yield* request.json.pipe(Effect.orElseSucceed(() => null)))
    }
    if (path === Routes.openaiDevEvents && request.method === "GET") {
      if (!operator()) return HttpServerResponse.text("Forbidden", { status: 403 })
      return yield* devEvents(url.searchParams.get("project"))
    }
    if (path === Routes.macActivity && request.method === "GET") {
      if (!operator()) return HttpServerResponse.text("Forbidden", { status: 403 })
      return yield* macActivity(url)
    }
    if (path === Routes.clientErrorsAdmin && request.method === "GET") {
      if (!operator()) return HttpServerResponse.text("Forbidden", { status: 403 })
      return yield* readClientErrors(url)
    }
    if (path === Routes.testflightBuilds && request.method === "GET") {
      if (!operator()) return HttpServerResponse.text("Forbidden", { status: 403 })
      const bundleId = url.searchParams.get("bundleId")
      if (bundleId !== null && !/^[A-Za-z0-9.-]{1,155}$/.test(bundleId))
        return HttpServerResponse.text("Bad bundle id", { status: 400 })
      const problem = (status: number, body: object) => Effect.succeed(HttpServerResponse.jsonUnsafe(body, { status }))
      return yield* readTestflightBuilds(bundleId ?? undefined).pipe(
        Effect.map((builds) =>
          HttpServerResponse.jsonUnsafe(Schema.encodeSync(Schema.toCodecJson(TestflightBuilds))(builds))
        ),
        Effect.catchTags({
          TestflightRateLimited: () => problem(429, { problem: "rate limited; try again in a minute" }),
          AscKeyUnusable: (e) => problem(500, { problem: `ASC_TESTFLIGHT_KEY_P8 doesn't import: ${e.reason}` }),
          AscRefused: (e) => problem(502, { appStoreConnect: e.status, problem: e.detail }),
          UpstreamFailure: (e) => problem(503, { problem: `${e.service}: ${e.message}` })
        })
      )
    }
    if (path === Routes.testflightKey && request.method === "POST") {
      const body = yield* request.json.pipe(Effect.orElseSucceed(() => null))
      return yield* releaseAscKey(body).pipe(
        Effect.map((release) => HttpServerResponse.jsonUnsafe(release)),
        // The reason goes to the log only; the caller learns nothing about which check failed.
        Effect.catchTag("TestflightDenied", (e) =>
          Effect.logWarning("refused the App Store Connect key", e.reason).pipe(
            Effect.as(HttpServerResponse.text("Forbidden", { status: 403 }))
          )
        ),
        Effect.catchTag("UpstreamFailure", (e) =>
          Effect.logWarning("couldn't release the App Store Connect key", e.message).pipe(
            Effect.as(HttpServerResponse.text("Unavailable", { status: 503 }))
          )
        )
      )
    }

    if (path === Routes.testflightIdentity && request.method === "POST") {
      const body = yield* request.json.pipe(Effect.orElseSucceed(() => null))
      return yield* storeSigningIdentity(body).pipe(
        Effect.map((certificateId) => HttpServerResponse.jsonUnsafe({ stored: certificateId })),
        Effect.catchTag("TestflightDenied", (e) =>
          Effect.logWarning("refused a TestFlight signing identity", e.reason).pipe(
            Effect.as(HttpServerResponse.text("Forbidden", { status: 403 }))
          )
        ),
        Effect.catchTag("UpstreamFailure", (e) =>
          Effect.logWarning("couldn't store the TestFlight signing identity", e.message).pipe(
            Effect.as(HttpServerResponse.text("Unavailable", { status: 503 }))
          )
        )
      )
    }

    // Metering: the Worker registers (or rotates) its own E2B webhook, and can backfill E2B's week of runs.
    if (path === Routes.meteringE2bWebhook && request.method === "POST") {
      if (!operator()) return HttpServerResponse.text("Forbidden", { status: 403 })
      return yield* registerE2bWebhook(url)
    }

    // Operator tool (e2e cleanup): delete a project for good. The path predates the name; scripts call it.
    const remove = /^\/admin\/projects\/([^/]+)\/archive$/.exec(path)
    if (remove !== null && request.method === "POST") {
      if (!operator()) return HttpServerResponse.text("Forbidden", { status: 403 })
      const projectId = Schema.decodeUnknownOption(ProjectId)(remove[1])
      if (Option.isNone(projectId)) return HttpServerResponse.text("Bad project id", { status: 400 })
      yield* deleteProject(projectId.value)
      return HttpServerResponse.text("deleted")
    }

    // The one-time token page from `CreateConnectLink`. Its body (the token) is never logged.
    const connect = /^\/connect\/([^/]+)$/.exec(path)
    if (connect !== null) {
      const provider = connectProvider(connect[1]!)
      if (Option.isSome(provider) && request.method === "GET")
        return yield* showConnectPage(provider.value, url.searchParams.get("t"))
      if (Option.isSome(provider) && request.method === "POST") return yield* submitConnectPage(provider.value)
    }

    // Finishing an access request on a computer, from an `EmailAccessLink` email. Bodies are never logged.
    if (path === Routes.desktop && request.method === "GET") return yield* showDesktopLanding
    if (path === Routes.desktopOpen && request.method === "POST") return yield* openDesktopLink
    const desktop = /^\/desktop\/(dsk_[A-Za-z0-9]+)(\/sign-in)?$/.exec(path)
    if (desktop !== null) {
      const linkId = desktop[1]!
      if (desktop[2] === undefined && request.method === "GET") return yield* showDesktopAccess(linkId)
      if (desktop[2] === undefined && request.method === "POST") return yield* submitDesktopAccess(linkId)
      if (desktop[2] !== undefined && request.method === "GET") return yield* startDesktopSignIn(linkId)
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
      const desktopLink = state === null ? undefined : desktopLinkOfState(state)
      if (desktopLink !== undefined) {
        const service = "Google"
        if (code === null || error !== null) {
          const reason = error === "access_denied" || error === null ? "cancelled" : error
          return yield* desktopSignInResult(desktopLink, { service, ok: false, error: reason })
        }
        const result = yield* access.finishGoogle(state!, code).pipe(Effect.result)
        return yield* desktopSignInResult(
          desktopLink,
          result._tag === "Success" ? { service, ok: true } : { service, ok: false, error: result.failure.message }
        )
      }
      if (state === null || code === null || error !== null)
        return back({ status: "error", error: error ?? "cancelled" })
      const result = yield* access.finishGoogle(state, code).pipe(Effect.result)
      return result._tag === "Success"
        ? back({ status: "connected", projectId: result.success.projectId, messageId: result.success.messageId })
        : back({ status: "error", error: result.failure.message })
    }

    // Every other OAuth provider (`Routes.oauthCallback`); the state names the request it answers.
    const oauthCallback = /^\/oauth\/([a-z0-9-]+)\/callback$/.exec(path)
    if (oauthCallback !== null && request.method === "GET") {
      const provider = oauthCallback[1]!
      const access = yield* Access
      const back = (params: Record<string, string>) =>
        HttpServerResponse.redirect(
          `${config.appScheme}://oauth/${provider}?${new URLSearchParams(params).toString()}`,
          { status: 302 }
        )
      const state = url.searchParams.get("state")
      const code = url.searchParams.get("code")
      const error = url.searchParams.get("error")
      const desktopLink = state === null ? undefined : desktopLinkOfState(state)
      if (desktopLink !== undefined) {
        const service = provider.charAt(0).toUpperCase() + provider.slice(1)
        if (code === null || error !== null) {
          const reason = error === "access_denied" || error === null ? "cancelled" : error
          return yield* desktopSignInResult(desktopLink, { service, ok: false, error: reason })
        }
        const result = yield* access.finishOAuth(provider, state!, code).pipe(Effect.result)
        return yield* desktopSignInResult(
          desktopLink,
          result._tag === "Success" ? { service, ok: true } : { service, ok: false, error: result.failure.message }
        )
      }
      if (state === null || code === null || error !== null)
        return back({ status: "error", error: error === "access_denied" || error === null ? "cancelled" : error })
      const result = yield* access.finishOAuth(provider, state, code).pipe(Effect.result)
      return result._tag === "Success"
        ? back({ status: "connected", projectId: result.success.projectId, messageId: result.success.messageId })
        : back({ status: "error", error: result.failure.message })
    }

    return HttpServerResponse.text("Not found", { status: 404 })
  })
