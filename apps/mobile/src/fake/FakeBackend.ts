/**
 * An in-memory stand-in for Dream's API, so the whole app runs without a
 * backend (`DREAM_BACKEND=fixtures`) and tests can drive real flows.
 *
 * It serves the same contracts as the Worker: `AppRpcs` handlers (wired to the
 * real RPC client through `RpcTest`) and the `ProjectLiveRpcs` event stream.
 * A small simulated agent answers back: it acknowledges answers, replies to
 * messages, names new projects and asks its first question, and finishes
 * Google and model sign-ins as if the person had completed them in a browser.
 */
import {
  type AccessMessage,
  type AppLink,
  type LinkId,
  linkHost,
  type AgentActivity,
  AppAuth,
  type ArchivedProject,
  AppRpcs,
  CurrentUser,
  type Device,
  InvalidRequest,
  type Integration,
  type IntegrationAccess,
  isOpenAsk,
  type Message,
  type MessageId,
  type ModelConnection,
  type ModelConnectionId,
  type ModelProvider,
  NotFound,
  type NotificationId,
  type OpenAsk,
  type Project,
  ProjectEvent,
  type ProjectId,
  type ProjectSummary,
  type PushData,
  sandboxKeyPath,
  type QuestionMessage,
  type StatusCard,
  type TextMessage,
  Unauthorized,
  type User,
  type WorkstreamId
} from "@dream/domain"
import { Context, DateTime, Duration, Effect, Layer, Option, PubSub, Redacted, Schema, Stream } from "effect"
import { Headers } from "effect/http"
import type { Rpc, RpcGroup } from "effect/rpc"
import { TolerantMessage } from "../data/Tolerant.ts"
import {
  type FixtureWorld,
  cabinHold,
  liftWorkstreams,
  longChat,
  longQuestion,
  makeWorld,
  newIntegrationId,
  questionWithContext,
  vagueAccess
} from "./fixtures.ts"
import {
  accountOf,
  afterTurn,
  glanceOf,
  makeUsageWorld,
  connectionUsageOf,
  type UsageMode,
  type UsageWorld,
  usageOf
} from "./usage.ts"

/** A notification the fake would have sent through APNs. The app shows it as a local notification. */
export interface FakePush {
  readonly title: string
  readonly body: string
  readonly category: "message" | "question" | "access"
  readonly data: PushData
}

/** Named states to jump to with `dream://fixtures/<name>` when checking screens. */
export const Scenario = [
  "reset",
  "paused",
  "all-clear",
  "cabin-resolved",
  "withdraw-cabin",
  "no-plan",
  "signed-in",
  "signed-out",
  "spotify-ask",
  "spotify-stopped",
  "long-question",
  "vague-access",
  "question-context",
  "unsupported-message",
  "stall-next-write",
  "activity-sent",
  "activity-starting",
  "activity-working",
  "activity-done",
  "activity-home",
  "activity-new-idea",
  "archived",
  "ask-series",
  "links-empty",
  "no-projects",
  "links-new",
  "long-chat",
  "now-two-lines",
  "now-three-lines",
  "declined-reason",
  "usage-normal",
  "usage-near-limit",
  "usage-none",
  "workstreams",
  "workstreams-waiting",
  "workstreams-many",
  "workstreams-one"
] as const
export type Scenario = (typeof Scenario)[number]

interface ProjectRecord {
  project: Project
  status: StatusCard
  messages: Array<Message>
  working: boolean
  activity: AgentActivity
  /** Set while it's archived: off Home and the deck, its agent held. */
  archivedAt?: DateTime.Utc
  readonly events: PubSub.PubSub<ProjectEvent>
}

/** How long a sandbox stays up after a turn (the ProjectDO's IdleTimeout). */
const awakeFor = Duration.minutes(5)

/** The next time the phone's clock reads `hours:minutes`. */
const nextLocal = (now: DateTime.Utc, hours: number, minutes: number) => {
  const local = new Date(DateTime.toEpochMillis(now))
  local.setHours(hours, minutes, 0, 0)
  if (local.getTime() <= DateTime.toEpochMillis(now)) local.setDate(local.getDate() + 1)
  return DateTime.makeUnsafe(local.getTime())
}

/** What each sample project's agent is up to when the world loads (Deck v3, A+B+C Home). */
const initialActivity = (slug: string, working: boolean, now: DateTime.Utc): AgentActivity => {
  if (working) return { state: "working", since: DateTime.subtract(now, { minutes: 2 }) }
  switch (slug) {
    case "morning-brief":
      return { state: "idle", since: DateTime.subtract(now, { hours: 7 }), nextWakeAt: nextLocal(now, 6, 55) }
    case "cabin": {
      const since = DateTime.subtract(now, { minutes: 1 })
      return { state: "idle", since, awakeUntil: DateTime.addDuration(since, awakeFor) }
    }
    default:
      return { state: "idle", since: DateTime.subtract(now, { hours: 3 }) }
  }
}

/**
 * The mock's one scenario, with a question the sample chat hasn't had yet: at 2:02 PM, with Lift Log asleep, they
 * ask something; its computer starts, it works, and it replies at 2:09.
 */
const liftAsk = { id: "msg_askrest" as MessageId, text: "Can the rest timer start on its own after each set?" }
const liftReply = {
  id: "msg_replyrest" as MessageId,
  text: "Yes. It’ll start the moment you log a set, and buzz when it’s time for the next one."
}
type ActivityStage = "sent" | "starting" | "working" | "done"

type AppHandlers = Rpc.ToHandler<RpcGroup.Rpcs<typeof AppRpcs>>

/** How many recent messages a snapshot carries; the rest come from `ListMessages`. */
const snapshotSize = 6

export class FakeBackend extends Context.Service<
  FakeBackend,
  {
    /** `AppRpcs` handlers over this backend's state. */
    readonly handlers: Context.Context<AppHandlers>
    readonly subscribe: (projectId: ProjectId) => Stream.Stream<ProjectEvent>
    readonly pushes: Stream.Stream<FakePush>
    readonly scenario: (name: Scenario) => Effect.Effect<void>
    /** Sets how long the simulated agent takes to respond (zero in tests). */
    readonly setPace: (pace: Duration.Input) => Effect.Effect<void>
  }
>()("@dream/mobile/FakeBackend") {
  static readonly layer = Layer.effect(
    FakeBackend,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const pushes = yield* PubSub.unbounded<FakePush>()
      let pace = Duration.seconds(1)
      // `stall-next-write`: the next write hangs, as on a weak connection, until the app gives up on it.
      let stallNextWrite = false
      const stallable = <A, E, R>(write: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          if (!stallNextWrite) return write
          stallNextWrite = false
          return Effect.never
        })
      let counter = 0
      const nextId = (prefix: string) => `${prefix}_fake${++counter}`

      let user: User
      let records = new Map<ProjectId, ProjectRecord>()
      let integrations: Array<Integration> = []
      let connections: Array<ModelConnection> = []
      let devices = new Map<string, Device>()
      let links: Array<AppLink> = []
      let usage: UsageWorld = makeUsageWorld("normal")

      const load = Effect.fn("FakeBackend.load")(function* (world: FixtureWorld) {
        const previous = records
        user = world.user
        integrations = [...world.integrations]
        links = [...world.links]
        usage = makeUsageWorld("normal")
        connections = [...world.modelConnections]
        devices = new Map()
        records = new Map()
        const now = yield* DateTime.now
        for (const fixture of world.projects) {
          const events = previous.get(fixture.project.id)?.events ?? (yield* PubSub.unbounded<ProjectEvent>())
          const activity = initialActivity(fixture.project.slug, fixture.working, now)
          records.set(fixture.project.id, { ...fixture, messages: [...fixture.messages], activity, events })
        }
        // Open subscriptions start over from a fresh snapshot, as after a reconnect.
        for (const record of records.values()) yield* PubSub.publish(record.events, snapshotOf(record))
        for (const [id, record] of previous) if (!records.has(id)) yield* PubSub.shutdown(record.events)
      })

      const snapshotOf = (record: ProjectRecord) =>
        ProjectEvent.cases.Snapshot.make({
          project: record.project,
          status: record.status,
          messages: record.messages.slice(-snapshotSize),
          hasEarlierMessages: record.messages.length > snapshotSize,
          working: record.working,
          activity: record.activity
        })

      yield* load(makeWorld(yield* DateTime.now))

      const find = (projectId: ProjectId) =>
        Effect.fromNullishOr(records.get(projectId)).pipe(
          Effect.mapError(() => new NotFound({ entity: "project", id: projectId }))
        )
      const findMessage = (projectId: ProjectId, messageId: MessageId) =>
        Effect.gen(function* () {
          const record = yield* find(projectId)
          const message = record.messages.find((m) => m.id === messageId)
          if (!message) return yield* new NotFound({ entity: "message", id: messageId })
          return { record, message }
        })

      const emit = (record: ProjectRecord, event: ProjectEvent) => PubSub.publish(record.events, event)
      const setMessage = (record: ProjectRecord, message: Message) =>
        Effect.gen(function* () {
          const index = record.messages.findIndex((m) => m.id === message.id)
          if (index === -1) {
            record.messages.push(message)
            yield* emit(record, ProjectEvent.cases.MessageAdded.make({ message }))
          } else {
            record.messages[index] = message
            yield* emit(record, ProjectEvent.cases.MessageChanged.make({ message }))
          }
          record.project = { ...record.project, updatedAt: yield* DateTime.now }
        })
      /** As the ProjectDO does: `WorkingChanged` for older builds when that flips, then `ActivityChanged`. */
      const setActivity = (record: ProjectRecord, activity: AgentActivity) =>
        Effect.gen(function* () {
          const working = activity.state === "working"
          record.activity = activity
          if (record.working !== working) {
            record.working = working
            yield* emit(record, ProjectEvent.cases.WorkingChanged.make({ working }))
          }
          yield* emit(record, ProjectEvent.cases.ActivityChanged.make({ activity }))
        })
      const nextWake = (record: ProjectRecord) =>
        record.activity.nextWakeAt ? { nextWakeAt: record.activity.nextWakeAt } : {}
      /** Delivery to the sandbox begins: their unseen messages read "Seen". */
      const markSeen = (record: ProjectRecord) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          for (const message of record.messages)
            if (message._tag === "Text" && message.from === "user" && message.seenAt === undefined)
              yield* setMessage(record, { ...message, seenAt: now })
        })
      /** The sandbox is being brought up to deliver something. */
      const startComputer = (record: ProjectRecord) =>
        Effect.gen(function* () {
          yield* setActivity(record, { state: "starting", since: yield* DateTime.now, ...nextWake(record) })
          yield* markSeen(record)
        })
      const startTurn = (record: ProjectRecord) =>
        Effect.gen(function* () {
          yield* markSeen(record)
          if (record.activity.state !== "working") {
            yield* setActivity(record, { state: "working", since: yield* DateTime.now, ...nextWake(record) })
          }
        })
      const endTurn = (record: ProjectRecord) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          yield* setActivity(record, {
            state: "idle",
            since: now,
            awakeUntil: DateTime.addDuration(now, awakeFor),
            ...nextWake(record)
          })
          usage = afterTurn(usage, record.project.id)
          yield* syncConnectionUsage
          yield* emitUsage(record)
        })
      const projectUsage = (projectId: ProjectId, now: DateTime.Utc) =>
        usageOf(
          usage,
          projectId,
          active().map((r) => r.project),
          now
        )
      /** As the ProjectDO does after each turn: the header's figures. */
      const emitUsage = (record: ProjectRecord) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          yield* emit(record, ProjectEvent.cases.Usage.make({ usage: glanceOf(projectUsage(record.project.id, now)) }))
        })
      const setUsage = (mode: UsageMode) =>
        Effect.gen(function* () {
          usage = makeUsageWorld(mode)
          yield* syncConnectionUsage
          for (const record of records.values()) yield* emitUsage(record)
        })
      /** The ChatGPT connection's usage follows the world, as dreamd's reports would. */
      const syncConnectionUsage = Effect.gen(function* () {
        const now = yield* DateTime.now
        connections = connections.map((c) =>
          c.status === "connected" && c.provider === "chatgpt" && c.usage
            ? { ...c, usage: connectionUsageOf(usage, c.usage, now) }
            : c
        )
      })
      const isAwake = (record: ProjectRecord, now: DateTime.Utc) =>
        record.activity.state !== "idle" ||
        (record.activity.awakeUntil !== undefined && DateTime.isGreaterThan(record.activity.awakeUntil, now))
      /** Something they did reaches the agent: its computer starts first if it was asleep. Returns the paces taken. */
      const wake = (record: ProjectRecord) =>
        Effect.gen(function* () {
          if (record.activity.state === "working") {
            yield* later(1, startTurn(record))
            return 1
          }
          if (isAwake(record, yield* DateTime.now)) {
            yield* later(1, startTurn(record))
            return 1
          }
          yield* later(1, startComputer(record))
          yield* later(3, startTurn(record))
          return 3
        })
      const setStatus = (record: ProjectRecord, patch: Partial<StatusCard>) =>
        Effect.gen(function* () {
          record.status = { ...record.status, ...patch, updatedAt: yield* DateTime.now }
          yield* emit(record, ProjectEvent.cases.StatusChanged.make({ status: record.status }))
        })
      const setProject = (record: ProjectRecord, patch: Partial<Project>) =>
        Effect.gen(function* () {
          record.project = { ...record.project, ...patch, updatedAt: yield* DateTime.now }
          yield* emit(record, ProjectEvent.cases.ProjectChanged.make({ project: record.project }))
        })

      const agentText = (record: ProjectRecord, text: string, workstream?: WorkstreamId) =>
        Effect.gen(function* () {
          const message: TextMessage = {
            _tag: "Text",
            id: nextId("msg") as MessageId,
            projectId: record.project.id,
            createdAt: yield* DateTime.now,
            from: "agent",
            text,
            media: [],
            ...(workstream === undefined ? {} : { workstream })
          }
          yield* setMessage(record, message)
          return message
        })

      /** Runs simulated agent work in the background, after `steps` of the current pace. */
      const later = (steps: number, effect: Effect.Effect<void>) =>
        Effect.sleep(Duration.times(pace, steps)).pipe(Effect.andThen(effect), Effect.forkIn(scope), Effect.asVoid)

      const push = (record: ProjectRecord, message: Message, body: string) =>
        Effect.gen(function* () {
          if (!message.notificationId) return
          yield* PubSub.publish(pushes, {
            title: record.project.title,
            body,
            category: message._tag === "Question" ? "question" : message._tag === "Access" ? "access" : "message",
            data: {
              _tag: "OpenMessage",
              projectId: record.project.id,
              messageId: message.id,
              notificationId: message.notificationId
            }
          })
        })

      const notificationId = () =>
        Effect.sync(() => {
          const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")
          return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}` as NotificationId
        })

      /** Projects on Home: all but the archived ones. */
      const active = () => Array.from(records.values()).filter((record) => record.archivedAt === undefined)

      const summaryOf = (record: ProjectRecord): ProjectSummary => {
        const milestones = record.status.milestones
        return {
          project: record.project,
          openAsks: record.messages.filter((m) => isOpenAsk(m) && !(m._tag === "Access" && m.when)).length,
          ...(milestones.length > 0
            ? { progress: { done: milestones.filter((m) => m.state === "done").length, total: milestones.length } }
            : {}),
          ...(record.status.pausedUntil ? { pausedUntil: record.status.pausedUntil } : {}),
          activity: record.activity
        }
      }

      const connectIntegration = (
        record: ProjectRecord,
        access: AccessMessage,
        label: string,
        how: IntegrationAccess
      ) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const integration: Integration = {
            id: newIntegrationId(++counter),
            label,
            status: "connected",
            access: how,
            connectedAt: now
          }
          integrations.push(integration)
          const connected: AccessMessage = {
            ...access,
            state: { _tag: "Connected", integrationId: integration.id, connectedAt: now }
          }
          yield* setMessage(record, connected)
          return connected
        })

      const ackAnswer = (record: ProjectRecord, question: QuestionMessage, text: string) =>
        Effect.gen(function* () {
          yield* startTurn(record)
          yield* later(
            2,
            Effect.gen(function* () {
              yield* agentText(record, `Got it: “${text}”. I’ll build around that and keep going.`)
              if (record.status.milestones.length === 0 && record.status.phase === "interviewing") {
                yield* setStatus(record, { now: `Shaping the first version around “${text}”.` })
                yield* setProject(record, { headline: `Shaping the first version around “${text}”.` })
              }
              yield* endTurn(record)
            })
          )
          return question
        })

      const titleFrom = (idea: string) => {
        const skip = new Set(["a", "an", "the", "app", "that", "which", "for", "to", "my", "i", "want", "me", "of"])
        const words = idea
          .replace(/[^\p{L}\p{N}\s-]/gu, "")
          .split(/\s+/)
          .filter((word) => word && !skip.has(word.toLowerCase()))
          .slice(0, 2)
        return words.length === 0 ? "New idea" : words.map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ")
      }

      const handlers = AppRpcs.toLayer({
        SignIn: () => Effect.succeed({ sessionToken: Redacted.make("fixtures-session"), user }),
        DevSignIn: ({ email, name }) =>
          Effect.succeed({
            sessionToken: Redacted.make("fixtures-session"),
            user: { ...user, email, ...(name ? { name } : {}) }
          }),
        GetMe: () => Effect.sync(() => user),
        RegisterDevice: (payload) =>
          Effect.gen(function* () {
            const device: Device = {
              id: payload.deviceId,
              userId: user.id,
              platform: "ios",
              timeZone: payload.timeZone,
              ...(payload.apnsToken ? { apnsToken: payload.apnsToken } : {}),
              ...(payload.pushToStartToken ? { pushToStartToken: payload.pushToStartToken } : {}),
              ...(payload.appVersion ? { appVersion: payload.appVersion } : {}),
              updatedAt: yield* DateTime.now
            }
            devices.set(device.id, device)
            return device
          }),
        UnregisterDevice: ({ deviceId }) => Effect.sync(() => void devices.delete(deviceId)),
        RegisterLiveActivity: ({ projectId }) => find(projectId).pipe(Effect.asVoid),
        FilterStaleNotifications: ({ notificationIds }) =>
          Effect.sync(() => {
            const live = new Set<string>()
            for (const record of records.values())
              for (const message of record.messages)
                if (message.notificationId && (message._tag === "Text" || isOpenAsk(message)))
                  live.add(message.notificationId.toLowerCase())
            return { stale: notificationIds.filter((id) => !live.has(id.toLowerCase())) }
          }),
        ListProjects: () => Effect.sync(() => Array.from(active(), summaryOf)),
        ListOpenAsks: () =>
          Effect.sync(() => {
            const asks: Array<OpenAsk> = []
            for (const record of active())
              for (const message of record.messages)
                if (isOpenAsk(message)) asks.push({ project: record.project, message })
            return asks.sort((a, b) => DateTime.Order(a.message.createdAt, b.message.createdAt))
          }),
        ListArchivedProjects: () =>
          Effect.sync(() =>
            Array.from(records.values())
              .flatMap(
                (record): Array<ArchivedProject> =>
                  record.archivedAt ? [{ project: record.project, archivedAt: record.archivedAt }] : []
              )
              .sort((a, b) => DateTime.Order(b.archivedAt, a.archivedAt))
          ),
        ArchiveProject: ({ projectId }) =>
          stallable(
            Effect.gen(function* () {
              const record = yield* find(projectId)
              record.archivedAt ??= yield* DateTime.now
              // Its agent is held, so nothing reads as working or starting while it's put away.
              if (record.activity.state !== "idle") {
                yield* setActivity(record, { state: "idle", since: yield* DateTime.now, ...nextWake(record) })
              }
              return { project: record.project, archivedAt: record.archivedAt }
            })
          ),
        DeleteProject: ({ projectId }) =>
          stallable(
            Effect.gen(function* () {
              const record = yield* find(projectId)
              records.delete(projectId)
              integrations = integrations.filter(
                (integration) => !(integration.access._tag === "File" && integration.access.projectId === projectId)
              )
              yield* PubSub.shutdown(record.events)
            })
          ),
        RestoreProject: ({ projectId }) =>
          stallable(
            Effect.gen(function* () {
              const record = yield* find(projectId)
              delete record.archivedAt
              return summaryOf(record)
            })
          ),
        CreateProject: ({ idea, harness }) =>
          stallable(
            Effect.gen(function* () {
              const now = yield* DateTime.now
              const id = nextId("prj") as ProjectId
              const project: Project = {
                id,
                ownerId: user.id,
                title: "New idea",
                kind: "Just now",
                idea,
                harness: harness ?? "codex",
                phase: "new",
                slug: `idea-${counter}`,
                publicUrl: `https://idea-${counter}-q7x2k9.omer.build`,
                createdAt: now,
                updatedAt: now
              }
              const record: ProjectRecord = {
                project,
                status: { phase: "new", phaseSince: now, media: [], milestones: [], updatedAt: now },
                messages: [
                  {
                    _tag: "Text",
                    id: nextId("msg") as MessageId,
                    projectId: id,
                    createdAt: now,
                    from: "user",
                    text: idea,
                    media: [],
                    seenAt: now
                  }
                ],
                working: false,
                activity: { state: "starting", since: now },
                events: yield* PubSub.unbounded<ProjectEvent>()
              }
              records = new Map([[id, record], ...records])
              yield* later(3, startTurn(record))
              yield* later(
                6,
                Effect.gen(function* () {
                  const title = titleFrom(idea)
                  yield* setProject(record, {
                    title,
                    kind: "Just started",
                    phase: "interviewing",
                    headline: "One question for you"
                  })
                  yield* setStatus(record, { phase: "interviewing", phaseSince: yield* DateTime.now })
                  const question: QuestionMessage = {
                    _tag: "Question",
                    id: nextId("msg") as MessageId,
                    projectId: id,
                    createdAt: yield* DateTime.now,
                    question: "Who’ll use this besides you?",
                    options: ["Nobody, just me", "My household", "Friends and family"],
                    why: "It decides whether I build accounts and sharing, or keep this as sharp as a personal tool.",
                    meanwhile: "I’ll keep researching how this should work; this only changes who it’s for.",
                    state: { _tag: "Open" },
                    notificationId: yield* notificationId()
                  }
                  yield* setMessage(record, question)
                  yield* endTurn(record)
                  yield* push(record, question, question.question)
                })
              )
              return project
            })
          ),
        ListLinks: () =>
          Effect.sync(() =>
            links.filter(
              (link) => link.projectId === undefined || active().some((r) => r.project.id === link.projectId)
            )
          ),
        AddLink: ({ url, title, icon, color }) =>
          stallable(
            Effect.gen(function* () {
              const now = yield* DateTime.now
              const host = linkHost(url)
              const project = Array.from(records.values()).find((r) => linkHost(r.project.publicUrl) === host)
              const link: AppLink = {
                id: nextId("lnk") as LinkId,
                url,
                title,
                ...(icon ? { icon } : {}),
                color,
                ...(project ? { projectId: project.project.id } : {}),
                addedBy: "person",
                createdAt: now,
                updatedAt: now,
                openedAt: now
              }
              links = [...links, link]
              return link
            })
          ),
        UpdateLink: ({ linkId, title, icon, color }) =>
          Effect.gen(function* () {
            const link = links.find((l) => l.id === linkId)
            if (!link) return yield* new NotFound({ entity: "link", id: linkId })
            const theirs = new Set(link.theirs ?? [])
            if (link.addedBy === "agent" && title !== undefined && title !== link.title) theirs.add("title")
            if (link.addedBy === "agent" && (icon !== undefined || color !== undefined)) theirs.add("icon")
            const { icon: _old, ...rest } = link
            const next: AppLink = {
              ...rest,
              ...(title === undefined ? {} : { title }),
              ...(icon === undefined ? (link.icon ? { icon: link.icon } : {}) : icon === null ? {} : { icon }),
              ...(color === undefined ? {} : { color }),
              ...(theirs.size > 0 ? { theirs: [...theirs] } : {}),
              updatedAt: yield* DateTime.now
            }
            links = links.map((l) => (l.id === linkId ? next : l))
            return next
          }),
        RemoveLink: ({ linkId }) =>
          Effect.sync(() => {
            links = links.filter((l) => l.id !== linkId)
          }),
        MarkLinkOpened: ({ linkId }) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now
            links = links.map((l) => (l.id === linkId && !l.openedAt ? { ...l, openedAt: now } : l))
          }),
        PrepareHomeScreen: ({ linkId }) =>
          Effect.gen(function* () {
            const link = links.find((l) => l.id === linkId)
            if (!link) return yield* new NotFound({ entity: "link", id: linkId })
            const published = Array.from(records.values()).some(
              (r) => linkHost(r.project.publicUrl) === linkHost(link.url)
            )
            return { url: published ? `${link.url}${link.url.includes("?") ? "&" : "?"}dream_home_screen=1` : link.url }
          }),
        GetLiveUrl: ({ projectId }) =>
          find(projectId).pipe(
            Effect.map(() => ({ url: `wss://fixtures.invalid/projects/${projectId}/live?ticket=${nextId("tkt")}` }))
          ),
        GetProjectUsage: ({ projectId }) =>
          Effect.gen(function* () {
            const record = yield* find(projectId)
            return projectUsage(record.project.id, yield* DateTime.now)
          }),
        GetAccountUsage: ({ provider }) =>
          Effect.gen(function* () {
            const connected = connections.some((c) => c.status === "connected" && c.provider === provider)
            if (!connected || provider !== "chatgpt")
              return yield* new NotFound({ entity: "model connection", id: provider })
            return accountOf(
              usage,
              active().map((r) => r.project),
              yield* DateTime.now
            )
          }),
        ListMessages: ({ projectId, before, limit }) =>
          Effect.gen(function* () {
            const record = yield* find(projectId)
            const end = before ? record.messages.findIndex((m) => m.id === before) : record.messages.length
            const until = end === -1 ? record.messages.length : end
            const from = Math.max(0, until - (limit ?? 50))
            return { messages: record.messages.slice(from, until).reverse(), hasEarlier: from > 0 }
          }),
        SendMessage: ({ projectId, text, workstream }) =>
          stallable(
            Effect.gen(function* () {
              const record = yield* find(projectId)
              // As the ProjectDO does: a workstream the project doesn't have is left off.
              const into = record.status.workstreams?.find((w) => w.id === workstream)?.id
              const message: TextMessage = {
                _tag: "Text",
                id: nextId("msg") as MessageId,
                projectId,
                createdAt: yield* DateTime.now,
                from: "user",
                text,
                media: [],
                ...(into === undefined ? {} : { workstream: into })
              }
              yield* setMessage(record, message)
              const taken = yield* wake(record)
              yield* later(
                taken + 3,
                Effect.gen(function* () {
                  yield* agentText(record, "Noted. I’ll fold that in and show you when it’s ready.", into)
                  yield* endTurn(record)
                })
              )
              return message
            })
          ),
        AnswerQuestion: ({ projectId, messageId, answer }) =>
          stallable(
            Effect.gen(function* () {
              const { record, message } = yield* findMessage(projectId, messageId)
              if (message._tag !== "Question")
                return yield* new InvalidRequest({ message: "That message isn't a question." })
              if (message.state._tag === "Withdrawn")
                return yield* new InvalidRequest({
                  message: "This question was withdrawn; it no longer needs an answer."
                })
              if (answer._tag === "Choice" && !message.options.includes(answer.option))
                return yield* new InvalidRequest({ message: `“${answer.option}” isn't one of the options.` })
              const updated: QuestionMessage = {
                ...message,
                state: { _tag: "Answered", answer, answeredAt: yield* DateTime.now }
              }
              yield* setMessage(record, updated)
              return yield* ackAnswer(record, updated, answer._tag === "Choice" ? answer.option : answer.text)
            })
          ),
        StartGoogleAccess: ({ projectId, messageId }) =>
          Effect.gen(function* () {
            const { record, message } = yield* findMessage(projectId, messageId)
            if (message._tag !== "Access" || message.request._tag !== "Google")
              return yield* new InvalidRequest({ message: "That request isn't a Google sign-in." })
            const scopes = message.request.scopes
            yield* later(
              1.3,
              Effect.gen(function* () {
                const label = scopes.some((s) => s.startsWith("calendar"))
                  ? "Google Calendar"
                  : scopes.some((s) => s.startsWith("gmail"))
                    ? "Gmail"
                    : "Google"
                yield* connectIntegration(record, message, label, {
                  _tag: "Google",
                  email: user.email,
                  scopes: [...scopes],
                  hosts: ["www.googleapis.com"],
                  placeholder: "dream-placeholder-google"
                })
                yield* later(2, agentText(record, `${label} is connected. I’ll take it from here.`).pipe(Effect.asVoid))
              })
            )
            return { authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?fixtures=${messageId}` }
          }),
        StartOAuthAccess: ({ projectId, messageId }) =>
          Effect.gen(function* () {
            const { record, message } = yield* findMessage(projectId, messageId)
            if (message._tag !== "Access" || message.request._tag !== "OAuth")
              return yield* new InvalidRequest({ message: "That request isn't an OAuth sign-in." })
            const request = message.request
            const service = request.service ?? request.provider
            yield* later(
              1.3,
              Effect.gen(function* () {
                yield* connectIntegration(record, message, service, {
                  _tag: "OAuth",
                  provider: request.provider,
                  service,
                  account: user.name ?? user.email,
                  scopes: [...request.scopes],
                  hosts: [`api.${request.provider}.com`],
                  placeholder: `dream-${request.provider}-oauth-placeholder`
                })
                yield* later(
                  2,
                  agentText(record, `${service} is connected. I’ll take it from here.`).pipe(Effect.asVoid)
                )
              })
            )
            return { authorizeUrl: `https://${request.provider}.example/authorize?fixtures=${messageId}` }
          }),
        SubmitKeyAccess: ({ projectId, messageId }) =>
          stallable(
            Effect.gen(function* () {
              const { record, message } = yield* findMessage(projectId, messageId)
              // As the API does: a retry of a submission that went through returns the card as it is.
              if (message._tag === "Access" && message.state._tag === "Connected") return message
              if (message._tag === "Access" && message.request._tag === "File") {
                const { service, name } = message.request
                const connected = yield* connectIntegration(record, message, service, {
                  _tag: "File",
                  service,
                  name,
                  path: sandboxKeyPath(name),
                  projectId
                })
                yield* later(
                  2,
                  agentText(record, `Got the ${service} key. Only the bot reads it, from its file here.`).pipe(
                    Effect.asVoid
                  )
                )
                return connected
              }
              if (message._tag !== "Access" || message.request._tag !== "Key")
                return yield* new InvalidRequest({ message: "That request isn't for a key." })
              const request = message.request
              return yield* connectIntegration(record, message, request.service, {
                _tag: "Key",
                service: request.service,
                host: request.host,
                header: request.header,
                format: request.format,
                placeholder: `dream-placeholder-${request.service.toLowerCase()}`
              })
            })
          ),
        SubmitAppleAccess: ({ projectId, messageId, issuerId, keyId }) =>
          Effect.gen(function* () {
            const { record, message } = yield* findMessage(projectId, messageId)
            if (message._tag !== "Access" || message.request._tag !== "Apple")
              return yield* new InvalidRequest({ message: "That request isn't for an App Store Connect key." })
            return yield* connectIntegration(record, message, "Apple Developer", { _tag: "Apple", issuerId, keyId })
          }),
        DeclineAccess: ({ projectId, messageId, reason }) =>
          stallable(
            Effect.gen(function* () {
              const { record, message } = yield* findMessage(projectId, messageId)
              if (message._tag !== "Access")
                return yield* new InvalidRequest({ message: "That message isn't an access request." })
              const declined: AccessMessage = {
                ...message,
                state: { _tag: "Declined", declinedAt: yield* DateTime.now, ...(reason ? { reason } : {}) }
              }
              yield* setMessage(record, declined)
              return declined
            })
          ),
        ListIntegrations: () => Effect.sync(() => [...integrations]),
        DisconnectIntegration: ({ integrationId }) =>
          Effect.gen(function* () {
            if (!integrations.some((i) => i.id === integrationId))
              return yield* new NotFound({ entity: "integration", id: integrationId })
            integrations = integrations.filter((i) => i.id !== integrationId)
            const now = yield* DateTime.now
            for (const record of records.values())
              for (const message of record.messages)
                if (
                  message._tag === "Access" &&
                  message.state._tag === "Connected" &&
                  message.state.integrationId === integrationId
                )
                  yield* setMessage(record, {
                    ...message,
                    state: { _tag: "Disconnected", integrationId, disconnectedAt: now, reason: "removed" }
                  })
          }),
        ReplaceKey: ({ integrationId }) =>
          Effect.gen(function* () {
            const integration = integrations.find((i) => i.id === integrationId)
            if (!integration) return yield* new NotFound({ entity: "integration", id: integrationId })
            if (integration.access._tag !== "Key" && integration.access._tag !== "File")
              return yield* new InvalidRequest({ message: `${integration.label} isn't a key.` })
            return integration
          }),
        ListModelConnections: () => Effect.sync(() => [...connections]),
        StartModelConnection: ({ provider }) =>
          Effect.gen(function* () {
            const connection: ModelConnection = {
              id: nextId("mcn") as ModelConnectionId,
              provider,
              status: "pending"
            }
            connections = [...connections.filter((c) => c.provider !== provider), connection]
            if (provider === "chatgpt") {
              yield* later(8, completeConnection(connection.id))
              return {
                connection,
                flow: {
                  _tag: "DeviceCode" as const,
                  verificationUrl: "https://auth.openai.com/codex/device",
                  userCode: "DRMX-4K2P",
                  expiresAt: DateTime.add(yield* DateTime.now, { minutes: 15 })
                }
              }
            }
            return {
              connection,
              flow: { _tag: "PasteCode" as const, authorizeUrl: "https://claude.ai/oauth/authorize?fixtures=1" }
            }
          }),
        CompleteModelConnection: ({ connectionId }) =>
          Effect.gen(function* () {
            yield* completeConnection(connectionId)
            const connection = connections.find((c) => c.id === connectionId)
            if (!connection) return yield* new NotFound({ entity: "model connection", id: connectionId })
            return connection
          }),
        GetModelConnection: ({ connectionId }) =>
          Effect.fromNullishOr(connections.find((c) => c.id === connectionId)).pipe(
            Effect.mapError(() => new NotFound({ entity: "model connection", id: connectionId }))
          ),
        DisconnectModelConnection: ({ connectionId }) =>
          Effect.gen(function* () {
            if (!connections.some((c) => c.id === connectionId))
              return yield* new NotFound({ entity: "model connection", id: connectionId })
            connections = connections.filter((c) => c.id !== connectionId)
          }),
        CreateConnectLink: ({ provider }) =>
          Effect.map(DateTime.now, (now) => ({
            url: `https://dream.fixtures.invalid/connect/${provider}?t=fixture`,
            expiresAt: DateTime.add(now, { minutes: 15 })
          }))
      })

      const completeConnection = (connectionId: ModelConnectionId) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          connections = connections.map((c) =>
            c.id === connectionId
              ? { ...c, status: "connected" as const, connectedAt: now, usage: usageFor(c.provider, now) }
              : c
          )
        })

      const usageFor = (provider: ModelProvider, now: DateTime.Utc) => ({
        provider,
        plan: provider === "chatgpt" ? "ChatGPT Pro" : "Claude Max",
        fiveHour: { usedPercent: 12, resetsAt: DateTime.add(now, { hours: 4 }) },
        weekly: { usedPercent: 38, resetsAt: DateTime.add(now, { days: 4 }) },
        observedAt: now
      })

      /** Lift Log asks to connect Spotify (`msg_spotify`), unless it already has. */
      const askSpotify = (now: DateTime.Utc) =>
        Effect.gen(function* () {
          const lift = Array.from(records.values()).find((r) => r.project.slug === "lift-log")
          if (!lift || lift.messages.some((m) => m.id === "msg_spotify")) return
          yield* setMessage(lift, {
            _tag: "Access",
            id: "msg_spotify" as MessageId,
            projectId: lift.project.id,
            createdAt: now,
            request: {
              _tag: "OAuth",
              provider: "spotify",
              service: "Spotify",
              scopes: ["user-read-playback-state", "user-modify-playback-state"]
            },
            why: "Connect Spotify so your lifting playlist starts when a session does.",
            state: { _tag: "Open" }
          })
        })

      /** Lift Log at one stage of the mock's scenario, re-sent as a fresh snapshot. */
      const liftStage = (stage: ActivityStage, now: DateTime.Utc) =>
        Effect.gen(function* () {
          const lift = Array.from(records.values()).find((r) => r.project.slug === "lift-log")
          if (!lift) return
          const sentAt =
            stage === "working"
              ? DateTime.subtract(now, { minutes: 2, seconds: 30 })
              : stage === "done"
                ? DateTime.subtract(now, { minutes: 7 })
                : now
          const ask: TextMessage = {
            _tag: "Text",
            ...liftAsk,
            projectId: lift.project.id,
            createdAt: sentAt,
            from: "user",
            media: [],
            ...(stage === "sent" ? {} : { seenAt: sentAt })
          }
          const reply: TextMessage = {
            _tag: "Text",
            ...liftReply,
            projectId: lift.project.id,
            createdAt: now,
            from: "agent",
            media: []
          }
          lift.messages = [
            ...lift.messages.filter((m) => m.id !== liftAsk.id && m.id !== liftReply.id),
            ask,
            ...(stage === "done" ? [reply] : [])
          ]
          lift.activity =
            stage === "sent"
              ? {
                  state: "idle",
                  since: DateTime.subtract(now, { minutes: 40 }),
                  awakeUntil: DateTime.subtract(now, { minutes: 35 })
                }
              : stage === "starting"
                ? { state: "starting", since: now }
                : stage === "working"
                  ? { state: "working", since: DateTime.subtract(now, { minutes: 2 }) }
                  : { state: "idle", since: now, awakeUntil: DateTime.addDuration(now, awakeFor) }
          lift.working = stage === "working"
          lift.project = { ...lift.project, updatedAt: now }
          yield* emit(lift, snapshotOf(lift))
        })

      /** Adds `message` to Lift Log's Chat, unless a message with its id is already there. */
      const addToLift = (message: (projectId: ProjectId, now: DateTime.Utc) => Message) =>
        Effect.gen(function* () {
          const lift = Array.from(records.values()).find((r) => r.project.slug === "lift-log")
          const now = yield* DateTime.now
          const added = lift ? message(lift.project.id, now) : undefined
          if (!lift || !added || lift.messages.some((m) => m.id === added.id)) return
          yield* setMessage(lift, added)
        })

      const scenario = Effect.fn("FakeBackend.scenario")(function* (name: Scenario) {
        const now = yield* DateTime.now
        switch (name) {
          case "reset":
            stallNextWrite = false
            return yield* load(makeWorld(now))
          case "links-empty":
            links = []
            return
          case "no-projects":
            // A new person's Home: no projects and no app links yet.
            records.clear()
            links = []
            return
          case "links-new": {
            // Lift Log's agent just published a second page; its tile shows the dot until they open it.
            const lift = Array.from(records.values()).find((r) => r.project.slug === "lift-log")
            if (!lift) return
            links = [
              ...links,
              {
                id: "lnk_liftlogtimer" as LinkId,
                url: `${lift.project.publicUrl}/timer`,
                title: "Rest timer",
                icon: { _tag: "Symbol", name: "timer" },
                color: "teal",
                projectId: lift.project.id,
                addedBy: "agent",
                createdAt: now,
                updatedAt: now
              },
              {
                id: "lnk_recipes" as LinkId,
                url: "https://www.seriouseats.com/the-food-lab",
                title: "Food Lab",
                icon: { _tag: "Emoji", emoji: "🍳" },
                color: "yellow",
                addedBy: "person",
                createdAt: now,
                updatedAt: now,
                openedAt: now
              }
            ]
            return
          }
          case "archived": {
            // Recipe Scaler was put away a few days ago, Morning Brief last month.
            const at = (slug: string, days: number) => {
              const record = Array.from(records.values()).find((r) => r.project.slug === slug)
              if (record) record.archivedAt = DateTime.subtract(now, { days })
            }
            at("recipe-scaler", 3)
            at("morning-brief", 26)
            return
          }
          case "paused": {
            const lift = Array.from(records.values()).find((r) => r.project.slug === "lift-log")
            if (lift) {
              yield* setStatus(lift, { pausedUntil: DateTime.add(now, { hours: 1, minutes: 28 }) })
              yield* setActivity(lift, { state: "idle", since: DateTime.subtract(now, { minutes: 20 }) })
            }
            return
          }
          case "all-clear": {
            for (const record of records.values())
              for (const message of record.messages)
                if (isOpenAsk(message) && message._tag === "Question")
                  yield* setMessage(record, {
                    ...message,
                    state: {
                      _tag: "Answered",
                      answer: { _tag: "Choice", option: message.options[0] ?? "" },
                      answeredAt: now
                    }
                  })
                else if (isOpenAsk(message) && message._tag === "Access" && !message.when)
                  yield* setMessage(record, { ...message, state: { _tag: "Declined", declinedAt: now } })
            return
          }
          case "cabin-resolved": {
            const cabin = Array.from(records.values()).find((r) => r.project.slug === "cabin")
            if (!cabin) return
            for (const message of cabin.messages) {
              if (message._tag === "Question" && message.question.startsWith("When two relatives"))
                yield* setMessage(cabin, {
                  ...message,
                  state: { _tag: "Answered", answer: { _tag: "Choice", option: "First to ask" }, answeredAt: now }
                })
              if (message._tag === "Access" && message.state._tag === "Open")
                yield* connectIntegration(cabin, message, "Google Calendar", {
                  _tag: "Google",
                  email: user.email,
                  scopes: message.request._tag === "Google" ? [...message.request.scopes] : [],
                  hosts: ["www.googleapis.com"],
                  placeholder: "dream-placeholder-google"
                })
            }
            return
          }
          case "no-plan":
            connections = []
            return
          case "spotify-ask":
            return yield* askSpotify(now)
          case "spotify-stopped": {
            // Lift Log's Spotify connection, which Spotify stopped renewing.
            yield* askSpotify(now)
            const lift = Array.from(records.values()).find((r) => r.project.slug === "lift-log")
            const ask = lift?.messages.find((m) => m.id === "msg_spotify")
            if (!lift || ask?._tag !== "Access" || ask.request._tag !== "OAuth") return
            const integration: Integration = {
              id: newIntegrationId(++counter),
              label: "Spotify",
              status: "failed",
              access: {
                _tag: "OAuth",
                provider: "spotify",
                service: "Spotify",
                account: user.name ?? user.email,
                scopes: [...ask.request.scopes],
                hosts: ["api.spotify.com"],
                placeholder: "dream-spotify-oauth-placeholder"
              },
              connectedAt: DateTime.subtract(now, { days: 3 })
            }
            integrations = [...integrations.filter((i) => i.label !== "Spotify"), integration]
            yield* setMessage(lift, {
              ...ask,
              state: { _tag: "Disconnected", integrationId: integration.id, disconnectedAt: now, reason: "failed" }
            })
            return
          }
          case "long-question":
            return yield* addToLift(longQuestion)
          case "vague-access":
            return yield* addToLift(vagueAccess)
          case "question-context":
            return yield* addToLift(questionWithContext)
          case "unsupported-message": {
            const cabin = Array.from(records.values()).find((r) => r.project.slug === "cabin")
            if (!cabin || cabin.messages.some((m) => m.id === "msg_unsupported")) return
            // A kind of message from a newer API, through the same lenient decoding the real clients use.
            const raw = {
              _tag: "Poll",
              id: "msg_unsupported",
              projectId: cabin.project.id,
              createdAt: DateTime.formatIso(now),
              question: "Which weekend works?",
              choices: ["Nov 14", "Nov 21"]
            }
            const message = Schema.decodeUnknownOption(TolerantMessage)(raw)
            if (Option.isSome(message)) yield* setMessage(cabin, message.value)
            return
          }
          case "usage-normal":
            return yield* setUsage("normal")
          case "usage-near-limit":
            return yield* setUsage("near-limit")
          case "usage-none":
            return yield* setUsage("none")
          case "stall-next-write":
            stallNextWrite = true
            return
          case "declined-reason": {
            // Cabin's calendar request, declined with a reason (the card says what they said).
            const cabin = Array.from(records.values()).find((r) => r.project.slug === "cabin")
            const ask = cabin?.messages.find((m) => m.id === "msg_gcal")
            if (!cabin || ask?._tag !== "Access") return
            return yield* setMessage(cabin, {
              ...ask,
              state: { _tag: "Declined", declinedAt: now, reason: "Use a free option instead" }
            })
          }
          case "ask-series": {
            // Cabin: three open questions and the calendar request.
            const cabin = Array.from(records.values()).find((r) => r.project.slug === "cabin")
            if (!cabin || cabin.messages.some((m) => m.id === "msg_cabinhold")) return
            return yield* setMessage(cabin, cabinHold(cabin.project.id, now))
          }
          case "long-chat": {
            // Lift Log: an afternoon of messages before the Health import, so Chat has history to read back through.
            const lift = Array.from(records.values()).find((r) => r.project.slug === "lift-log")
            const update = lift?.messages.find((m) => m.id === "msg_liftimport")
            if (!lift || !update || lift.messages.some((m) => m.id === "msg_long1")) return
            const added = longChat(lift.project.id, update.createdAt)
            const at = lift.messages.indexOf(update)
            lift.messages = [...lift.messages.slice(0, at), ...added, ...lift.messages.slice(at)]
            return yield* emit(lift, snapshotOf(lift))
          }
          case "now-two-lines":
          case "now-three-lines": {
            // Lift Log's now sentence running long: two lines on the card, or three, which the card cuts to two.
            const lift = Array.from(records.values()).find((r) => r.project.slug === "lift-log")
            if (!lift) return
            return yield* setStatus(lift, {
              now:
                name === "now-two-lines"
                  ? "Building progress charts for squat, bench and deadlift."
                  : "Building progress charts for squat, bench and deadlift, then wiring the rest timer into its own Live Activity."
            })
          }
          case "workstreams":
          case "workstreams-waiting":
          case "workstreams-many":
          case "workstreams-one": {
            // Lift Log running several things at once (mocks/screens/workstreams, option A).
            const lift = Array.from(records.values()).find((r) => r.project.slug === "lift-log")
            if (!lift) return
            const stage =
              name === "workstreams-waiting"
                ? "waiting"
                : name === "workstreams-many"
                  ? "many"
                  : name === "workstreams-one"
                    ? "one"
                    : "three"
            const base = lift.messages.filter((m) => !m.id.startsWith("msg_ws"))
            const latest = base.reduce(
              (max, m) => (DateTime.isGreaterThan(m.createdAt, max) ? m.createdAt : max),
              lift.project.updatedAt
            )
            const { workstreams, labels, added } = liftWorkstreams(stage, lift.project.id, latest)
            lift.messages = [
              ...base.map((m) => {
                const label = labels.get(m.id)
                return label === undefined ? m : { ...m, workstream: label }
              }),
              ...added
            ]
            lift.status = { ...lift.status, workstreams, updatedAt: now }
            return yield* emit(lift, snapshotOf(lift))
          }
          case "activity-sent":
            return yield* liftStage("sent", now)
          case "activity-starting":
            return yield* liftStage("starting", now)
          case "activity-working":
            return yield* liftStage("working", now)
          case "activity-done":
            return yield* liftStage("done", now)
          case "activity-home": {
            yield* liftStage("done", DateTime.subtract(now, { minutes: 3 }))
            const recipe = Array.from(records.values()).find((r) => r.project.slug === "recipe-scaler")
            if (recipe) {
              yield* setStatus(recipe, { pausedUntil: nextLocal(now, 16, 0) })
              yield* setActivity(recipe, { state: "idle", since: DateTime.subtract(now, { hours: 1 }) })
            }
            return
          }
          case "activity-new-idea": {
            const id = "prj_newidea" as ProjectId
            if (records.has(id)) return
            const idea = "Scale any recipe up or down, and keep the ingredient math honest."
            const project: Project = {
              id,
              ownerId: user.id,
              title: "New idea",
              kind: "Just now",
              idea,
              harness: "codex",
              phase: "new",
              slug: "new-idea",
              publicUrl: "https://new-idea-q7x2k9.omer.build",
              createdAt: now,
              updatedAt: now
            }
            records = new Map([
              [
                id,
                {
                  project,
                  status: { phase: "new", phaseSince: now, media: [], milestones: [], updatedAt: now },
                  messages: [
                    {
                      _tag: "Text",
                      id: "msg_newidea" as MessageId,
                      projectId: id,
                      createdAt: now,
                      from: "user",
                      text: idea,
                      media: [],
                      seenAt: now
                    }
                  ],
                  working: false,
                  activity: { state: "starting", since: now },
                  events: yield* PubSub.unbounded<ProjectEvent>()
                }
              ],
              ...records
            ])
            return
          }
          case "signed-in":
          case "signed-out":
            return
          case "withdraw-cabin": {
            const cabin = Array.from(records.values()).find((r) => r.project.slug === "cabin")
            const rule = cabin?.messages.find((m) => m._tag === "Question" && m.state._tag === "Open")
            if (cabin && rule && rule._tag === "Question") {
              yield* setMessage(cabin, { ...rule, state: { _tag: "Withdrawn", withdrawnAt: now } })
              if (rule.notificationId)
                yield* PubSub.publish(pushes, {
                  title: "",
                  body: "",
                  category: "message",
                  data: { _tag: "Withdraw", notificationIds: [rule.notificationId] }
                })
            }
            return
          }
        }
      })

      const handlerServices = yield* Layer.build(handlers)

      return FakeBackend.of({
        handlers: handlerServices,
        subscribe: (projectId) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const record = records.get(projectId)
              if (!record) return Stream.never
              // Subscribe before taking the snapshot so no change falls between them.
              const subscription = yield* PubSub.subscribe(record.events)
              return Stream.make(snapshotOf(record)).pipe(Stream.concat(Stream.fromSubscription(subscription)))
            })
          ),
        pushes: Stream.fromPubSub(pushes),
        scenario,
        setPace: (input) => Effect.sync(() => void (pace = Duration.fromInputUnsafe(input)))
      })
    })
  )
}

/** Server side of `AppAuth` for the fake: any bearer token is the fixture user, except `expired`. */
export const FakeAppAuth = Layer.succeed(AppAuth, (effect, { headers }) =>
  Option.match(Headers.get(headers, "authorization"), {
    onNone: () => Effect.fail(new Unauthorized({ message: "Sign in first." })),
    onSome: (value) =>
      value === "Bearer expired"
        ? Effect.fail(new Unauthorized({ message: "Your session expired. Sign in again." }))
        : Effect.provideService(effect, CurrentUser, { userId: "usr_ada" as User["id"], email: "ada@example.com" })
  })
)

/** The `AppRpcs` handlers the fake serves, for `RpcTest.makeClient`. */
export const FakeHandlers = Layer.effectContext(
  Effect.gen(function* () {
    const backend = yield* FakeBackend
    return backend.handlers
  })
)
