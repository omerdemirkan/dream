/**
 * `SandboxRpcs` in the Worker (dreamd → `Routes.sandbox`, project token).
 * Calls that need only D1 or R2 are answered here; everything else goes to
 * the project's DO unchanged, but for calls that would show one of the
 * project's file keys to the person, which are refused here.
 */
import {
  AccessRequest,
  CurrentProject,
  InvalidRequest,
  MediaRef,
  NotFound,
  SandboxAuth,
  SandboxRpcs,
  Unauthorized
} from "@dream/domain"
import { DateTime, Effect, Layer, Option } from "effect"
import type { RpcClientError } from "effect/rpc"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { Connections, toIntegration } from "../db/Connections.ts"
import { Projects } from "../db/Projects.ts"
import { Google } from "../integrations/Google.ts"
import { KeyFiles } from "../integrations/KeyFiles.ts"
import { AppLinks } from "../links/AppLinks.ts"
import { OAuthProviders, scopesFor } from "../integrations/OAuth.ts"
import { newMediaId } from "../lib/Ids.ts"
import { type ProjectClient, ProjectClients } from "../project/Client.ts"
import { bearer } from "./AppHandlers.ts"
import { MediaStore } from "./Media.ts"

export const MaxUploadBytes = 200 * 1024 * 1024

export const SandboxAuthServer = Layer.effect(
  SandboxAuth,
  Effect.gen(function* () {
    const tokens = yield* Tokens
    return SandboxAuth.of((effect, { headers }) =>
      Option.match(bearer(headers), {
        onNone: () => Effect.fail(new Unauthorized({ message: "Missing the project token." })),
        onSome: (token) =>
          tokens.verifyProject(token).pipe(
            Effect.mapError(() => new Unauthorized({ message: "Invalid project token." })),
            Effect.flatMap((project) => Effect.provideService(effect, CurrentProject, project))
          )
      })
    )
  })
)

export const WorkerSandboxHandlers = SandboxRpcs.toLayer(
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const clients = yield* ProjectClients
    const connections = yield* Connections
    const projects = yield* Projects
    const tokens = yield* Tokens
    const media = yield* MediaStore
    const keyFiles = yield* KeyFiles
    const providers = yield* OAuthProviders
    const google = yield* Google
    const appLinks = yield* AppLinks

    const current = Effect.gen(function* () {
      return yield* CurrentProject
    })
    /** The DO trusts the Worker, so its SandboxAuth never fails; drop that case from the error type. */
    const forward = <A, E>(call: (client: ProjectClient) => Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const { projectId } = yield* current
        return yield* clients.use(projectId, call)
      }) as Effect.Effect<A, Exclude<E, Unauthorized | RpcClientError.RpcClientError>, CurrentProject>
    /** `forward`, unless `payload` contains one of the project's file keys. */
    const forwardUnlessLeaking = <A, E>(payload: unknown, call: (client: ProjectClient) => Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const { projectId, userId } = yield* current
        yield* keyFiles.refuseLeak(userId, projectId, payload)
        return yield* forward(call)
      })

    return {
      SendMessage: (payload) => forwardUnlessLeaking(payload, (c) => c.SendMessage(payload)),
      AskQuestion: (payload) => forwardUnlessLeaking(payload, (c) => c.AskQuestion(payload)),
      WithdrawQuestion: (payload) => forward((c) => c.WithdrawQuestion(payload)),
      RequestAccess: (payload) =>
        Effect.gen(function* () {
          const request = payload.request
          // Said at the moment it asks, so the agent never shows a card nobody can connect.
          if (request._tag === "Google") yield* google.configured
          if (request._tag !== "OAuth") return yield* forwardUnlessLeaking(payload, (c) => c.RequestAccess(payload))
          const { spec } = yield* providers.configured(request.provider)
          const oauth = AccessRequest.cases.OAuth.make({
            provider: spec.id,
            service: spec.service,
            scopes: scopesFor(spec, request.scopes)
          })
          return yield* forwardUnlessLeaking(payload, (c) => c.RequestAccess({ ...payload, request: oauth }))
        }),
      ListAccess: () =>
        Effect.gen(function* () {
          const { projectId, userId } = yield* current
          const rows = yield* connections.integrations(userId)
          return rows
            .filter((row) => row.status === "connected")
            .filter((row) => row.access_json._tag !== "File" || row.access_json.projectId === projectId)
            .map(toIntegration)
        }),
      WithdrawNotification: (payload) => forward((c) => c.WithdrawNotification(payload)),
      GetStatus: () => forward((c) => c.GetStatus()),
      UpdateStatus: (payload) => forwardUnlessLeaking(payload, (c) => c.UpdateStatus(payload)),
      ListWorkstreams: () => forward((c) => c.ListWorkstreams()),
      StartWorkstream: (payload) => forwardUnlessLeaking(payload, (c) => c.StartWorkstream(payload)),
      UpdateWorkstream: (payload) => forwardUnlessLeaking(payload, (c) => c.UpdateWorkstream(payload)),
      EndWorkstream: (payload) => forwardUnlessLeaking(payload, (c) => c.EndWorkstream(payload)),
      RouteMessage: (payload) => forward((c) => c.RouteMessage(payload)),
      StartLiveActivity: (payload) => forwardUnlessLeaking(payload, (c) => c.StartLiveActivity(payload)),
      UpdateLiveActivity: (payload) => forwardUnlessLeaking(payload, (c) => c.UpdateLiveActivity(payload)),
      EndLiveActivity: (payload) => forwardUnlessLeaking(payload, (c) => c.EndLiveActivity(payload)),
      ScheduleWake: (payload) => forwardUnlessLeaking(payload, (c) => c.ScheduleWake(payload)),
      ListWakes: () => forward((c) => c.ListWakes()),
      CancelWake: (payload) => forward((c) => c.CancelWake(payload)),
      WakeNow: (payload) => forward((c) => c.WakeNow(payload)),
      Publish: (payload) => forward((c) => c.Publish(payload)),
      AddLink: (payload) =>
        Effect.gen(function* () {
          const { projectId, userId } = yield* current
          yield* keyFiles.refuseLeak(userId, projectId, payload)
          return yield* appLinks.addByAgent(projectId, userId, payload)
        }),
      UpdateLink: ({ linkId, ...changes }) =>
        Effect.gen(function* () {
          const { projectId, userId } = yield* current
          yield* keyFiles.refuseLeak(userId, projectId, changes)
          return yield* appLinks.updateByAgent(projectId, linkId, changes)
        }),
      RemoveLink: ({ linkId }) => Effect.flatMap(current, ({ projectId }) => appLinks.removeByAgent(projectId, linkId)),
      ListLinks: () => Effect.flatMap(current, ({ projectId }) => appLinks.listForAgent(projectId)),
      CreateMediaUpload: ({ filename, contentType, sizeBytes, caption }) =>
        Effect.gen(function* () {
          const { projectId, userId } = yield* current
          if (Option.isNone(media.bucket)) {
            return yield* new InvalidRequest({
              message:
                "Media storage isn't switched on for this deployment yet, so files can't be attached. Send text for now."
            })
          }
          if (sizeBytes > MaxUploadBytes) {
            return yield* new InvalidRequest({
              message: `${filename} is larger than ${MaxUploadBytes / 1024 / 1024} MB.`
            })
          }
          const id = yield* newMediaId()
          const ref = MediaRef.make({
            id,
            kind: contentType === "video/mp4" ? "video" : "image",
            contentType,
            sizeBytes,
            ...(caption === undefined ? {} : { caption })
          })
          yield* projects.insertMedia({ ref, projectId, userId, objectKey: `projects/${projectId}/media/${id}` })
          const upload = yield* tokens.upload({ mid: id, pid: projectId, ct: contentType, size: sizeBytes })
          return {
            media: ref,
            upload: {
              url: `${config.apiUrl}/media/${id}/upload?token=${encodeURIComponent(upload.token)}`,
              method: "PUT" as const,
              headers: { "content-type": contentType },
              expiresAt: DateTime.makeUnsafe(upload.expiresAtMs)
            }
          }
        }),
      StartBrowser: () => forward((c) => c.StartBrowser()),
      StopBrowser: (payload) => forward((c) => c.StopBrowser(payload)),
      GetBrowserRecording: (payload) => forward((c) => c.GetBrowserRecording(payload)),
      StartMac: () => forward((c) => c.StartMac()),
      GetMac: () => forward((c) => c.GetMac()),
      GetMacSsh: () => forward((c) => c.GetMacSsh()),
      StopMac: () => forward((c) => c.StopMac()),
      GetUsage: () =>
        Effect.gen(function* () {
          const { projectId, userId } = yield* current
          const project = yield* projects.find(projectId)
          const provider = Option.match(project, {
            onNone: () => "claude" as const,
            onSome: (p) => (p.harness === "codex" ? ("chatgpt" as const) : ("claude" as const))
          })
          const connection = yield* connections.connectedModel(userId, provider)
          if (Option.isNone(connection) || connection.value.usage_json === null) {
            return yield* new NotFound({ entity: "usage", id: provider })
          }
          return connection.value.usage_json
        }),
      ReportUsage: (payload) => forward((c) => c.ReportUsage(payload)),
      AddRelay: (payload) => forwardUnlessLeaking(payload, (c) => c.AddRelay(payload)),
      ListRelays: () => forward((c) => c.ListRelays()),
      RemoveRelay: (payload) => forward((c) => c.RemoveRelay(payload)),
      RestartRelay: (payload) => forward((c) => c.RestartRelay(payload)),
      ReportTurn: (payload) => forward((c) => c.ReportTurn(payload)),
      ReportTask: (payload) => forward((c) => c.ReportTask(payload)),
      StayAwake: (payload) => forward((c) => c.StayAwake(payload)),
      Sleep: (payload) => forward((c) => c.Sleep(payload))
    }
  })
)
