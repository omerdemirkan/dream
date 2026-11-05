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
  AppAuth,
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
  type QuestionMessage,
  type StatusCard,
  type TextMessage,
  Unauthorized,
  type User
} from "@dream/domain"
import { Context, DateTime, Duration, Effect, Layer, Option, PubSub, Redacted, Stream } from "effect"
import { Headers } from "effect/http"
import type { Rpc, RpcGroup } from "effect/rpc"
import { type FixtureWorld, makeWorld, newIntegrationId } from "./fixtures.ts"

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
  "signed-out"
] as const
export type Scenario = (typeof Scenario)[number]

interface ProjectRecord {
  project: Project
  status: StatusCard
  messages: Array<Message>
  working: boolean
  readonly events: PubSub.PubSub<ProjectEvent>
}

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
      let counter = 0
      const nextId = (prefix: string) => `${prefix}_fake${++counter}`

      let user: User
      let records = new Map<ProjectId, ProjectRecord>()
      let integrations: Array<Integration> = []
      let connections: Array<ModelConnection> = []
      let devices = new Map<string, Device>()

      const load = Effect.fn("FakeBackend.load")(function* (world: FixtureWorld) {
        const previous = records
        user = world.user
        integrations = [...world.integrations]
        connections = [...world.modelConnections]
        devices = new Map()
        records = new Map()
        for (const fixture of world.projects) {
          const events = previous.get(fixture.project.id)?.events ?? (yield* PubSub.unbounded<ProjectEvent>())
          records.set(fixture.project.id, { ...fixture, messages: [...fixture.messages], events })
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
          working: record.working
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
      const setWorking = (record: ProjectRecord, working: boolean) =>
        Effect.gen(function* () {
          record.working = working
          yield* emit(record, ProjectEvent.cases.WorkingChanged.make({ working }))
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

      const agentText = (record: ProjectRecord, text: string) =>
        Effect.gen(function* () {
          const message: TextMessage = {
            _tag: "Text",
            id: nextId("msg") as MessageId,
            projectId: record.project.id,
            createdAt: yield* DateTime.now,
            from: "agent",
            text,
            media: []
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

      const summaryOf = (record: ProjectRecord): ProjectSummary => {
        const milestones = record.status.milestones
        return {
          project: record.project,
          openAsks: record.messages.filter((m) => isOpenAsk(m) && !(m._tag === "Access" && m.when)).length,
          ...(milestones.length > 0
            ? { progress: { done: milestones.filter((m) => m.state === "done").length, total: milestones.length } }
            : {}),
          ...(record.status.pausedUntil ? { pausedUntil: record.status.pausedUntil } : {})
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
          yield* setWorking(record, true)
          yield* later(
            2,
            Effect.gen(function* () {
              yield* agentText(record, `Got it: “${text}”. I’ll build around that and keep going.`)
              if (record.status.milestones.length === 0 && record.status.phase === "interviewing") {
                yield* setStatus(record, { now: `Shaping the first version around “${text}”.` })
                yield* setProject(record, { headline: `Shaping the first version around “${text}”.` })
              }
              yield* setWorking(record, false)
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
        ListProjects: () => Effect.sync(() => Array.from(records.values(), summaryOf)),
        ListOpenAsks: () =>
          Effect.sync(() => {
            const asks: Array<OpenAsk> = []
            for (const record of records.values())
              for (const message of record.messages)
                if (isOpenAsk(message)) asks.push({ project: record.project, message })
            return asks.sort((a, b) => DateTime.Order(a.message.createdAt, b.message.createdAt))
          }),
        CreateProject: ({ idea, harness }) =>
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
                  media: []
                }
              ],
              working: true,
              events: yield* PubSub.unbounded<ProjectEvent>()
            }
            records = new Map([[id, record], ...records])
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
                yield* setWorking(record, false)
                yield* push(record, question, question.question)
              })
            )
            return project
          }),
        GetLiveUrl: ({ projectId }) =>
          find(projectId).pipe(
            Effect.map(() => ({ url: `wss://fixtures.invalid/projects/${projectId}/live?ticket=${nextId("tkt")}` }))
          ),
        ListMessages: ({ projectId, before, limit }) =>
          Effect.gen(function* () {
            const record = yield* find(projectId)
            const end = before ? record.messages.findIndex((m) => m.id === before) : record.messages.length
            const until = end === -1 ? record.messages.length : end
            const from = Math.max(0, until - (limit ?? 50))
            return { messages: record.messages.slice(from, until).reverse(), hasEarlier: from > 0 }
          }),
        SendMessage: ({ projectId, text }) =>
          Effect.gen(function* () {
            const record = yield* find(projectId)
            const message: TextMessage = {
              _tag: "Text",
              id: nextId("msg") as MessageId,
              projectId,
              createdAt: yield* DateTime.now,
              from: "user",
              text,
              media: []
            }
            yield* setMessage(record, message)
            yield* later(1, setWorking(record, true))
            yield* later(
              5,
              Effect.gen(function* () {
                yield* agentText(record, "Noted. I’ll fold that in and show you when it’s ready.")
                yield* setWorking(record, false)
              })
            )
            return message
          }),
        AnswerQuestion: ({ projectId, messageId, answer }) =>
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
          }),
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
        SubmitKeyAccess: ({ projectId, messageId }) =>
          Effect.gen(function* () {
            const { record, message } = yield* findMessage(projectId, messageId)
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
          }),
        SubmitAppleAccess: ({ projectId, messageId, issuerId, keyId }) =>
          Effect.gen(function* () {
            const { record, message } = yield* findMessage(projectId, messageId)
            if (message._tag !== "Access" || message.request._tag !== "Apple")
              return yield* new InvalidRequest({ message: "That request isn't for an App Store Connect key." })
            return yield* connectIntegration(record, message, "Apple Developer", { _tag: "Apple", issuerId, keyId })
          }),
        DeclineAccess: ({ projectId, messageId }) =>
          Effect.gen(function* () {
            const { record, message } = yield* findMessage(projectId, messageId)
            if (message._tag !== "Access")
              return yield* new InvalidRequest({ message: "That message isn't an access request." })
            const declined: AccessMessage = { ...message, state: { _tag: "Declined", declinedAt: yield* DateTime.now } }
            yield* setMessage(record, declined)
            return declined
          }),
        ListIntegrations: () => Effect.sync(() => [...integrations]),
        DisconnectIntegration: ({ integrationId }) =>
          Effect.gen(function* () {
            if (!integrations.some((i) => i.id === integrationId))
              return yield* new NotFound({ entity: "integration", id: integrationId })
            integrations = integrations.filter((i) => i.id !== integrationId)
            for (const record of records.values())
              for (const message of record.messages)
                if (
                  message._tag === "Access" &&
                  message.state._tag === "Connected" &&
                  message.state.integrationId === integrationId
                )
                  yield* setMessage(record, { ...message, state: { _tag: "Open" } })
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
          })
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

      const scenario = Effect.fn("FakeBackend.scenario")(function* (name: Scenario) {
        const now = yield* DateTime.now
        switch (name) {
          case "reset":
            return yield* load(makeWorld(now))
          case "paused": {
            const lift = Array.from(records.values()).find((r) => r.project.slug === "lift-log")
            if (lift) {
              yield* setStatus(lift, { pausedUntil: DateTime.add(now, { hours: 1, minutes: 28 }) })
              yield* setWorking(lift, false)
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

/** Server side of `AppAuth` for the fake: any bearer token is the fixture user. */
export const FakeAppAuth = Layer.succeed(AppAuth, (effect, { headers }) =>
  Option.isSome(Headers.get(headers, "authorization"))
    ? Effect.provideService(effect, CurrentUser, { userId: "usr_ada" as User["id"], email: "ada@example.com" })
    : Effect.fail(new Unauthorized({ message: "Sign in first." }))
)

/** The `AppRpcs` handlers the fake serves, for `RpcTest.makeClient`. */
export const FakeHandlers = Layer.effectContext(
  Effect.gen(function* () {
    const backend = yield* FakeBackend
    return backend.handlers
  })
)
