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
  type AccessMessage,
  type AppLink,
  type AppNotification,
  type AppSender,
  CurrentProject,
  InvalidRequest,
  LinkId,
  HttpRpcSerialization,
  MediaId,
  MessageId,
  NotFound,
  type ProjectId,
  type Relay,
  RelayId,
  Routes,
  SandboxAuth,
  SandboxRpcs,
  type StatusCard,
  Unauthorized,
  UpstreamFailure,
  type UsageSnapshot,
  type UserId,
  type Wake,
  WakeId,
  type Workstream,
  WorkstreamId
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
    const apps = yield* Ref.make<ReadonlyArray<AppSender>>([])
    const sentByApps = yield* Ref.make<ReadonlyArray<AppNotification>>([])
    const status = yield* Ref.make<StatusCard>({
      phase: "new",
      phaseSince: start,
      media: [],
      milestones: [],
      updatedAt: start
    })
    const wakes = yield* Ref.make<ReadonlyArray<Wake>>([])
    const usage = yield* Ref.make<Option.Option<UsageSnapshot>>(Option.none())
    const links = yield* Ref.make<ReadonlyArray<AppLink>>([])
    const workstreams = yield* Ref.make<ReadonlyArray<Workstream>>([])
    const report = Effect.map(Ref.get(workstreams), (all) => ({ workstreams: all, waiting: [] }))
    const changeWorkstream = (workstreamId: WorkstreamId, change: (w: Workstream, now: DateTime.Utc) => Workstream) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const all = yield* Ref.get(workstreams)
        if (!all.some((w) => w.id === workstreamId))
          return yield* new NotFound({ entity: "workstream", id: workstreamId })
        yield* Ref.set(
          workstreams,
          all.map((w) => (w.id === workstreamId ? change(w, now) : w))
        )
        return yield* report
      })
    const relays = yield* Ref.make<ReadonlyArray<Relay>>([])
    const about = { projectTitle: "Dev project", publicUrl: "https://dev-3000.dream.example" }
    const findLink = (linkId: LinkId) =>
      Effect.flatMap(Ref.get(links), (all) => {
        const found = all.find((link) => link.id === linkId)
        return found === undefined ? Effect.fail(new NotFound({ entity: "link", id: linkId })) : Effect.succeed(found)
      })
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
            media: [],
            ...(payload.workstream === undefined ? {} : { workstream: payload.workstream })
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
      ListWorkstreams: () => log("ListWorkstreams", {}).pipe(Effect.andThen(report)),
      StartWorkstream: (payload) =>
        log("StartWorkstream", payload).pipe(
          Effect.andThen(DateTime.now),
          Effect.flatMap((now) =>
            Ref.update(workstreams, (all) => [
              ...all,
              {
                id: WorkstreamId.make(id("ws")),
                title: payload.title,
                ...(payload.now === undefined ? {} : { now: payload.now }),
                state: "active" as const,
                startedAt: now,
                updatedAt: now
              }
            ])
          ),
          Effect.andThen(report)
        ),
      UpdateWorkstream: (payload) =>
        log("UpdateWorkstream", payload).pipe(
          Effect.andThen(
            changeWorkstream(payload.workstreamId, ({ now: previous, ...w }, now) => {
              const line = clear(payload.now, previous)
              return {
                ...w,
                title: payload.title ?? w.title,
                ...(line === undefined ? {} : { now: line }),
                updatedAt: now
              }
            })
          )
        ),
      EndWorkstream: (payload) =>
        log("EndWorkstream", payload).pipe(
          Effect.andThen(
            changeWorkstream(payload.workstreamId, (w, now) => ({
              ...w,
              state: payload.state,
              ...(payload.result === undefined ? {} : { result: payload.result }),
              updatedAt: now,
              endedAt: now
            }))
          )
        ),
      RouteMessage: (payload) =>
        log("RouteMessage", payload).pipe(
          Effect.andThen(Effect.fail(new NotFound({ entity: "message", id: payload.messageId })))
        ),
      WithdrawNotification: (payload) => log("WithdrawNotification", payload),
      // Apps that notify: allowed as soon as they're set up, since nobody is here to tap Allow.
      SetUpAppNotifications: (payload) =>
        log("SetUpAppNotifications", payload).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const now = yield* DateTime.now
              const card: AccessMessage = {
                _tag: "Access",
                id: MessageId.make(id("msg")),
                projectId,
                createdAt: now,
                request: {
                  _tag: "Notifications",
                  app: payload.app,
                  name: payload.name,
                  often: payload.often,
                  ...(payload.icon === undefined ? {} : { icon: payload.icon }),
                  ...(payload.color === undefined ? {} : { color: payload.color })
                },
                why: payload.why,
                state: { _tag: "Allowed", allowedAt: now }
              }
              const app: AppSender = {
                id: payload.app,
                name: payload.name,
                ...(payload.icon === undefined ? {} : { icon: payload.icon }),
                color: payload.color ?? "blue",
                ...(payload.url === undefined ? {} : { url: payload.url }),
                why: payload.why,
                often: payload.often,
                messageId: card.id,
                state: { _tag: "Allowed", allowedAt: now },
                delivery: "immediate",
                createdAt: now
              }
              yield* Ref.update(apps, (list) => [...list.filter((a) => a.id !== app.id), app])
              return { app, card }
            })
          )
        ),
      SendAppNotification: (payload) =>
        log("SendAppNotification", payload).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const app = (yield* Ref.get(apps)).find((a) => a.id === payload.app)
              if (app === undefined) {
                return yield* new InvalidRequest({ message: `No app "${payload.app}" is set up to notify them.` })
              }
              const notification: AppNotification = {
                id: crypto.randomUUID() as AppNotification["id"],
                app: app.id,
                ...(payload.title === undefined ? {} : { title: payload.title }),
                text: payload.text,
                ...(payload.url === undefined ? {} : { url: payload.url }),
                ...(payload.key === undefined ? {} : { key: payload.key }),
                outcome: payload.quiet ? "quiet" : "sent",
                sentAt: yield* DateTime.now
              }
              if (!payload.dryRun) yield* Ref.update(sentByApps, (list) => [notification, ...list])
              return notification
            })
          )
        ),
      ListAppNotifications: (payload) =>
        log("ListAppNotifications", payload).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const keep = (app: string) => payload.app === undefined || app === payload.app
              return {
                apps: (yield* Ref.get(apps)).filter((a) => keep(a.id)),
                notifications: (yield* Ref.get(sentByApps)).filter((n) => keep(n.app))
              }
            })
          )
        ),
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
      AddLink: (payload) =>
        Effect.gen(function* () {
          yield* log("AddLink", payload)
          const all = yield* Ref.get(links)
          if (all.length >= 3) return yield* new InvalidRequest({ message: "This project already has 3 links." })
          const now = yield* DateTime.now
          const link: AppLink = {
            id: LinkId.make(id("lnk")),
            ...payload,
            projectId,
            addedBy: "agent",
            createdAt: now,
            updatedAt: now
          }
          yield* Ref.set(links, [...all, link])
          return { link, ...about }
        }),
      UpdateLink: ({ linkId, icon, ...rest }) =>
        Effect.gen(function* () {
          yield* log("UpdateLink", { linkId, icon, ...rest })
          const found = yield* findLink(linkId)
          const { icon: previous, ...kept } = found
          const nextIcon = clear(icon, previous)
          const link: AppLink = {
            ...kept,
            ...rest,
            ...(nextIcon === undefined ? {} : { icon: nextIcon }),
            updatedAt: yield* DateTime.now
          }
          yield* Ref.update(links, (all) => all.map((l) => (l.id === linkId ? link : l)))
          return { link, ...about }
        }),
      RemoveLink: ({ linkId }) =>
        log("RemoveLink", { linkId }).pipe(
          Effect.andThen(findLink(linkId)),
          Effect.andThen(Ref.update(links, (all) => all.filter((l) => l.id !== linkId)))
        ),
      ListLinks: () =>
        log("ListLinks", {}).pipe(
          Effect.andThen(Ref.get(links)),
          Effect.map((all) => ({ links: all, ...about }))
        ),
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
      AddRelay: (payload) =>
        Effect.gen(function* () {
          yield* log("AddRelay", payload)
          const relay: Relay = {
            id: RelayId.make(id("rly")),
            ...(payload.label === undefined ? {} : { label: payload.label }),
            source: payload.source,
            target: payload.target,
            createdAt: yield* DateTime.now,
            state: "connecting",
            waiting: 0,
            delivered: 0,
            dropped: 0,
            problems: []
          }
          yield* Ref.update(relays, (all) => [...all, relay])
          return relay
        }),
      ListRelays: () => log("ListRelays", {}).pipe(Effect.andThen(Ref.get(relays))),
      RemoveRelay: ({ relayId }) =>
        Effect.gen(function* () {
          yield* log("RemoveRelay", { relayId })
          const all = yield* Ref.get(relays)
          if (!all.some((relay) => relay.id === relayId)) return yield* new NotFound({ entity: "relay", id: relayId })
          yield* Ref.set(
            relays,
            all.filter((relay) => relay.id !== relayId)
          )
        }),
      RestartRelay: ({ relayId }) =>
        Effect.gen(function* () {
          yield* log("RestartRelay", { relayId })
          const relay = (yield* Ref.get(relays)).find((each) => each.id === relayId)
          if (relay === undefined) return yield* new NotFound({ entity: "relay", id: relayId })
          return relay
        }),
      ReportTurn: (payload) => log("ReportTurn", payload),
      ReportTask: (payload) =>
        log("ReportTask", encode(SandboxRpcs.requests.get("ReportTask")!.payloadSchema, payload)),
      StayAwake: (payload) => log("StayAwake", payload),
      Sleep: (payload) => log("Sleep", payload)
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
