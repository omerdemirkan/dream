/**
 * A stand-in for the Worker's `SandboxRpcs`, for running dreamd end to end
 * without the control plane: it keeps a Status card and wakes in memory,
 * accepts media uploads, and prints every call as a JSON line.
 *
 *   node packages/dreamd/scripts/fake-api.ts [port]     (default 8787)
 *
 * Point dreamd at it with DREAM_API_URL=http://127.0.0.1:<port>. It accepts
 * the project token "dev-project-token".
 */
import { createServer } from "node:http"
import {
  CurrentProject,
  HttpRpcSerialization,
  MediaId,
  MessageId,
  NotFound,
  type ProjectId,
  Routes,
  SandboxAuth,
  SandboxRpcs,
  type StatusCard,
  Unauthorized,
  UpstreamFailure,
  type UsageSnapshot,
  type UserId,
  type Wake,
  WakeId
} from "@dream/domain"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
import { Headers, HttpRouter, HttpServerResponse } from "effect/http"
import { RpcServer } from "effect/rpc"

const port = Number(process.argv[2] ?? 8787)
const projectId = "prj_dev" as ProjectId
let counter = 0
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`
const log = (rpc: string, payload: unknown) =>
  Effect.sync(() => console.log(JSON.stringify({ at: new Date().toISOString(), rpc, payload })))
const encode = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]) =>
  Schema.encodeUnknownSync(Schema.toCodecJson(schema))(value)

const Handlers = SandboxRpcs.toLayer(
  Effect.gen(function* () {
    const start = yield* DateTime.now
    const status = yield* Ref.make<StatusCard>({
      phase: "new",
      phaseSince: start,
      media: [],
      milestones: [],
      updatedAt: start
    })
    const wakes = yield* Ref.make<ReadonlyArray<Wake>>([])
    const usage = yield* Ref.make<Option.Option<UsageSnapshot>>(Option.none())
    const unavailable = (service: string) =>
      Effect.fail(new UpstreamFailure({ service, message: "not available in the fake API" }))
    const message = { projectId, createdAt: start }
    const clear = <A>(value: A | null | undefined, previous: A | undefined) =>
      value === null ? undefined : value === undefined ? previous : value
    return {
      SendMessage: (payload) =>
        log("SendMessage", payload).pipe(
          Effect.as({
            _tag: "Text" as const,
            ...message,
            id: MessageId.make(id("msg")),
            from: "agent" as const,
            text: payload.text,
            media: []
          })
        ),
      AskQuestion: (payload) =>
        log("AskQuestion", payload).pipe(
          Effect.as({
            _tag: "Question" as const,
            ...message,
            id: MessageId.make(id("msg")),
            ...payload,
            state: { _tag: "Open" as const }
          })
        ),
      WithdrawQuestion: (payload) =>
        log("WithdrawQuestion", payload).pipe(
          Effect.andThen(Effect.fail(new NotFound({ entity: "question", id: payload.messageId })))
        ),
      RequestAccess: (payload) =>
        log("RequestAccess", encode(SandboxRpcs.requests.get("RequestAccess")!.payloadSchema, payload)).pipe(
          Effect.as({
            _tag: "Access" as const,
            ...message,
            id: MessageId.make(id("msg")),
            ...payload,
            state: { _tag: "Open" as const }
          })
        ),
      ListAccess: () => log("ListAccess", {}).pipe(Effect.as([])),
      WithdrawNotification: (payload) => log("WithdrawNotification", payload),
      GetStatus: () => log("GetStatus", {}).pipe(Effect.andThen(Ref.get(status))),
      UpdateStatus: (payload) =>
        log("UpdateStatus", encode(SandboxRpcs.requests.get("UpdateStatus")!.payloadSchema, payload)).pipe(
          Effect.andThen(DateTime.now),
          Effect.flatMap((now) =>
            Ref.updateAndGet(status, (card) => {
              const now_ = clear(payload.now, card.now)
              const justDid = clear(payload.justDid, card.justDid)
              const next = clear(payload.next, card.next)
              return {
                phase: payload.phase ?? card.phase,
                phaseSince: payload.phase !== undefined && payload.phase !== card.phase ? now : card.phaseSince,
                media: card.media,
                milestones: payload.milestones ?? card.milestones,
                updatedAt: now,
                ...(now_ === undefined ? {} : { now: now_ }),
                ...(justDid === undefined ? {} : { justDid }),
                ...(next === undefined ? {} : { next })
              }
            })
          )
        ),
      StartLiveActivity: (payload) => log("StartLiveActivity", payload),
      UpdateLiveActivity: (payload) => log("UpdateLiveActivity", payload),
      EndLiveActivity: (payload) => log("EndLiveActivity", payload),
      ScheduleWake: (payload) =>
        Effect.gen(function* () {
          yield* log("ScheduleWake", encode(SandboxRpcs.requests.get("ScheduleWake")!.payloadSchema, payload))
          const wake: Wake = {
            id: WakeId.make(id("wak")),
            ...payload,
            ...(payload.when._tag === "At" ? { nextAt: payload.when.at } : {}),
            createdAt: yield* DateTime.now
          }
          yield* Ref.update(wakes, (all) => [...all, wake])
          return wake
        }),
      ListWakes: () => log("ListWakes", {}).pipe(Effect.andThen(Ref.get(wakes))),
      CancelWake: (payload) =>
        log("CancelWake", payload).pipe(
          Effect.andThen(Ref.update(wakes, (all) => all.filter((w) => w.id !== payload.wakeId)))
        ),
      WakeNow: (payload) => log("WakeNow", payload),
      Publish: (payload) =>
        log("Publish", payload).pipe(Effect.as({ url: `https://dev-${payload.port}.dream.example` })),
      CreateMediaUpload: (payload) =>
        Effect.gen(function* () {
          yield* log("CreateMediaUpload", payload)
          const mediaId = MediaId.make(id("med"))
          return {
            media: {
              id: mediaId,
              kind: payload.contentType === "video/mp4" ? ("video" as const) : ("image" as const),
              contentType: payload.contentType,
              sizeBytes: payload.sizeBytes,
              ...(payload.caption === undefined ? {} : { caption: payload.caption })
            },
            upload: {
              url: `http://127.0.0.1:${port}/upload/${mediaId}`,
              method: "PUT" as const,
              headers: {},
              expiresAt: DateTime.add(yield* DateTime.now, { minutes: 10 })
            }
          }
        }),
      StartBrowser: () => log("StartBrowser", {}).pipe(Effect.andThen(unavailable("Browserbase"))),
      StopBrowser: (payload) => log("StopBrowser", payload).pipe(Effect.andThen(unavailable("Browserbase"))),
      GetBrowserRecording: (payload) =>
        log("GetBrowserRecording", payload).pipe(Effect.andThen(unavailable("Browserbase"))),
      StartMac: () => log("StartMac", {}).pipe(Effect.andThen(unavailable("Namespace"))),
      GetMac: () => log("GetMac", {}).pipe(Effect.as({ state: "stopped" as const, idleTimeoutMinutes: 20 })),
      GetMacSsh: () => log("GetMacSsh", {}).pipe(Effect.andThen(unavailable("Namespace"))),
      StopMac: () => log("StopMac", {}).pipe(Effect.andThen(unavailable("Namespace"))),
      GetUsage: () =>
        log("GetUsage", {}).pipe(
          Effect.andThen(Ref.get(usage)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new NotFound({ entity: "usage", id: projectId })),
              onSome: Effect.succeed
            })
          )
        ),
      ReportUsage: (payload) =>
        log("ReportUsage", encode(SandboxRpcs.requests.get("ReportUsage")!.payloadSchema, payload)).pipe(
          Effect.andThen(Ref.set(usage, Option.some(payload.usage)))
        ),
      ReportTurn: (payload) => log("ReportTurn", payload)
    }
  })
)

const Auth = Layer.succeed(SandboxAuth, (effect, { headers }) =>
  Option.getOrUndefined(Headers.get(headers, "authorization")) === "Bearer dev-project-token"
    ? Effect.provideService(effect, CurrentProject, { projectId, userId: "usr_dev" as UserId })
    : Effect.fail(new Unauthorized({ message: "Wrong project token" }))
)

const Uploads = HttpRouter.add("PUT", "/upload/:id", Effect.succeed(HttpServerResponse.empty({ status: 200 })))

HttpRouter.serve(
  Layer.mergeAll(
    RpcServer.layerHttp({ group: SandboxRpcs, path: Routes.sandbox, protocol: "http" }).pipe(
      Layer.provide([Handlers, Auth, HttpRpcSerialization])
    ),
    Uploads
  ),
  { disableLogger: true }
).pipe(
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port, host: "0.0.0.0" })),
  Layer.launch,
  NodeRuntime.runMain
)
