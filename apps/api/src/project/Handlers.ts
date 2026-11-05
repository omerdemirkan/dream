/**
 * The ProjectDO's RPC handlers: `ProjectRpcs` (the Worker acting for the
 * phone, OAuth callbacks and crons) and `SandboxRpcs` (the agent, through
 * dreamd and the Worker), plus `ProjectLiveRpcs` for the phone's socket.
 */
import {
  AccessMessage,
  AccessState,
  AgentEvent,
  CurrentProject,
  InvalidRequest,
  type MediaId,
  type MediaRef,
  type Message,
  NotFound,
  ProjectLiveRpcs,
  QuestionMessage,
  QuestionState,
  SandboxAuth,
  SandboxRpcs,
  type StatusCard,
  TextMessage,
  type Wake,
  type WakeWhen,
  DefaultDaemonPort
} from "@dream/domain"
import { Clock, Cron, DateTime, Effect, Layer, Option, Result } from "effect"
import { Connections } from "../db/Connections.ts"
import { Projects } from "../db/Projects.ts"
import { Users } from "../db/Users.ts"
import { CredentialStore } from "../integrations/CredentialStore.ts"
import { newEventId, newMessageId, newNotificationId, newWakeId } from "../lib/Ids.ts"
import { Alarm } from "./Alarm.ts"
import { ProjectDirectory } from "./Client.ts"
import { Core, initialStatus } from "./Core.ts"
import { LiveFeed } from "./Live.ts"
import { Machines } from "./Machines.ts"
import { Notifier } from "./Notifier.ts"
import { ProjectRpcs } from "./ProjectRpcs.ts"
import { SandboxManager } from "./SandboxManager.ts"
import { Singletons, Store } from "./Store.ts"

const notFound = (entity: string, id: string) => new NotFound({ entity, id })

/** The next time a wake is due after `fromMs`, or none for a fired one-off / unparseable cron. */
export const nextWakeAt = (when: WakeWhen, defaultTimeZone: string, fromMs: number): Option.Option<number> => {
  if (when._tag === "At") {
    const at = DateTime.toEpochMillis(when.at)
    return at > fromMs ? Option.some(at) : Option.none()
  }
  const parsed = Cron.parse(when.expression, when.timeZone ?? defaultTimeZone)
  if (Result.isFailure(parsed)) return Option.none()
  return Option.some(Cron.next(parsed.success, new Date(fromMs)).getTime())
}

export const ProjectHandlers = ProjectRpcs.toLayer(
  Effect.gen(function* () {
    const core = yield* Core
    const store = yield* Store
    const notifier = yield* Notifier
    const sandbox = yield* SandboxManager
    const credentials = yield* CredentialStore
    const connections = yield* Connections
    const directory = yield* ProjectDirectory
    const alarm = yield* Alarm

    const findMessage = (id: Message["id"]) =>
      Effect.flatMap(core.message(id), (found) =>
        Option.match(found, { onNone: () => Effect.fail(notFound("message", id)), onSome: Effect.succeed })
      )

    const findAccess = (id: Message["id"]) =>
      Effect.flatMap(findMessage(id), (message) =>
        message._tag === "Access" ? Effect.succeed(message) : Effect.fail(notFound("access request", id))
      )

    const event = <A>(make: (fields: { readonly id: AgentEvent["id"]; readonly at: DateTime.Utc }) => A) =>
      Effect.gen(function* () {
        return make({ id: yield* newEventId(), at: yield* DateTime.now })
      })

    return {
      Init: ({ project }) =>
        Effect.gen(function* () {
          const existing = yield* core.projectOption
          if (Option.isSome(existing)) return existing.value
          const now = yield* DateTime.now
          yield* store.putSingleton(...Singletons.status, initialStatus(now))
          yield* core.saveProject(project)
          const first = TextMessage.make({
            id: yield* newMessageId(),
            projectId: project.id,
            createdAt: now,
            from: "user",
            text: project.idea,
            media: []
          })
          yield* core.addMessage(first)
          yield* core.enqueue(
            yield* event((fields) =>
              AgentEvent.cases.UserMessage.make({ ...fields, messageId: first.id, text: project.idea })
            )
          )
          return project
        }),

      GetProject: () => core.project,

      ListMessages: ({ before, limit }) => store.messagesBefore(before, limit),

      SendUserMessage: ({ text }) =>
        Effect.gen(function* () {
          const project = yield* core.project.pipe(Effect.orDie)
          const message = TextMessage.make({
            id: yield* newMessageId(),
            projectId: project.id,
            createdAt: yield* DateTime.now,
            from: "user",
            text,
            media: []
          })
          yield* core.addMessage(message)
          yield* core.enqueue(
            yield* event((fields) => AgentEvent.cases.UserMessage.make({ ...fields, messageId: message.id, text }))
          )
          return message
        }),

      AnswerQuestion: ({ messageId, answer }) =>
        Effect.gen(function* () {
          const message = yield* findMessage(messageId)
          if (message._tag !== "Question") return yield* notFound("question", messageId)
          if (message.state._tag === "Withdrawn") {
            return yield* new InvalidRequest({
              message: "This question was withdrawn; it doesn't need an answer anymore."
            })
          }
          if (answer._tag === "Choice" && !message.options.includes(answer.option)) {
            return yield* new InvalidRequest({ message: `"${answer.option}" isn't one of this question's options.` })
          }
          const previous = message.state._tag === "Answered" ? message.state.answer : undefined
          const answered = QuestionMessage.make({
            ...message,
            state: QuestionState.cases.Answered.make({ answer, answeredAt: yield* DateTime.now })
          })
          yield* core.changeMessage(answered)
          yield* core.enqueue(
            yield* event((fields) =>
              AgentEvent.cases.QuestionAnswered.make({
                ...fields,
                messageId,
                question: message.question,
                answer,
                ...(previous === undefined ? {} : { previous })
              })
            )
          )
          yield* notifier.withdrawFor(answered)
          yield* notifier.asksChanged
          return answered
        }),

      GetOpenAccess: ({ messageId }) =>
        Effect.gen(function* () {
          const message = yield* findAccess(messageId)
          if (message.state._tag !== "Open") {
            return yield* new InvalidRequest({ message: "This access request isn't open anymore." })
          }
          return message
        }),

      AccessConnected: ({ messageId, integration }) =>
        Effect.gen(function* () {
          const message = yield* findAccess(messageId)
          if (message.state._tag === "Connected") return message
          const connected = AccessMessage.make({
            ...message,
            state: AccessState.cases.Connected.make({ integrationId: integration.id, connectedAt: yield* DateTime.now })
          })
          yield* core.changeMessage(connected)
          yield* core.enqueue(
            yield* event((fields) =>
              AgentEvent.cases.AccessConnected.make({
                ...fields,
                messageId,
                label: integration.label,
                access: integration.access
              })
            )
          )
          yield* notifier.withdrawFor(connected)
          yield* notifier.asksChanged
          return connected
        }),

      DeclineAccess: ({ messageId }) =>
        Effect.gen(function* () {
          const message = yield* findAccess(messageId)
          if (message.state._tag !== "Open") {
            return yield* new InvalidRequest({ message: "This access request isn't open anymore." })
          }
          const declined = AccessMessage.make({
            ...message,
            state: AccessState.cases.Declined.make({ declinedAt: yield* DateTime.now })
          })
          yield* core.changeMessage(declined)
          yield* core.enqueue(yield* event((fields) => AgentEvent.cases.AccessDeclined.make({ ...fields, messageId })))
          yield* notifier.withdrawFor(declined)
          yield* notifier.asksChanged
          return declined
        }),

      RegisterLiveActivity: (device) => notifier.registerLive(device),

      CredentialsChanged: () => sandbox.refreshRules,

      UsageLimited: ({ window, until }) =>
        Effect.gen(function* () {
          const current = yield* core.usagePause
          const wakeOnReset = Option.isSome(current) && current.value.wakeOnReset
          yield* core.saveUsagePause(Option.some({ window, until, wakeOnReset }))
          yield* store.setTimer("usage-reset", DateTime.toEpochMillis(until))
          yield* alarm.reschedule
        }),

      GatewayTarget: () => sandbox.gatewayTarget,

      RefreshModelCredential: () =>
        Effect.gen(function* () {
          const project = yield* core.project.pipe(Effect.orDie)
          const connection = yield* connections.connectedModel(project.ownerId, "chatgpt")
          if (Option.isNone(connection)) return
          yield* credentials.chatGpt(connection.value, true)
          yield* sandbox.refreshRules
          yield* directory.credentialsChanged(project.ownerId).pipe(Effect.forkDetach)
        })
    }
  })
)

/** The DO side of SandboxAuth: the Worker already checked the project token. */
export const SandboxAuthServer = Layer.effect(
  SandboxAuth,
  Effect.gen(function* () {
    const core = yield* Core
    return SandboxAuth.of((effect) =>
      Effect.flatMap(core.project.pipe(Effect.orDie), (project) =>
        Effect.provideService(effect, CurrentProject, { projectId: project.id, userId: project.ownerId })
      )
    )
  })
)

export const AgentHandlers = SandboxRpcs.toLayer(
  Effect.gen(function* () {
    const core = yield* Core
    const store = yield* Store
    const notifier = yield* Notifier
    const sandbox = yield* SandboxManager
    const machines = yield* Machines
    const projects = yield* Projects
    const users = yield* Users
    const connections = yield* Connections
    const directory = yield* ProjectDirectory
    const alarm = yield* Alarm

    const project = core.project.pipe(Effect.orDie)

    const resolveMedia = (ids: ReadonlyArray<MediaId>) =>
      Effect.gen(function* () {
        const current = yield* project
        const refs: Array<MediaRef> = []
        for (const id of ids) {
          const row = yield* projects.media(id)
          if (Option.isNone(row) || row.value.project_id !== current.id) {
            return yield* new InvalidRequest({
              message: `There's no media ${id} in this project. Upload it with \`dream media upload\`.`
            })
          }
          if (row.value.uploaded_at === null) {
            return yield* new InvalidRequest({ message: `Media ${id} hasn't finished uploading.` })
          }
          refs.push(row.value.ref_json)
        }
        return refs
      })

    const timeZone = Effect.flatMap(project, (current) =>
      Effect.map(users.find(current.ownerId), (user) =>
        Option.match(user, { onNone: () => "UTC", onSome: (u) => u.timeZone ?? "UTC" })
      )
    )

    const findMessage = (id: Message["id"]) =>
      Effect.flatMap(core.message(id), (found) =>
        Option.match(found, { onNone: () => Effect.fail(notFound("message", id)), onSome: Effect.succeed })
      )

    const patchStatus = (
      status: StatusCard,
      key: "now" | "justDid" | "next",
      value: string | null | undefined
    ): StatusCard => {
      if (value === undefined) return status
      const { [key]: _, ...rest } = status
      return value === null || value === "" ? (rest as StatusCard) : { ...rest, [key]: value }
    }

    return {
      SendMessage: ({ text, media, notify }) =>
        Effect.gen(function* () {
          const current = yield* project
          const refs = yield* resolveMedia(media)
          const notificationId = notify ? yield* newNotificationId() : undefined
          const message = TextMessage.make({
            id: yield* newMessageId(),
            projectId: current.id,
            createdAt: yield* DateTime.now,
            from: "agent",
            text,
            media: refs,
            ...(notificationId === undefined ? {} : { notificationId })
          })
          yield* core.addMessage(message)
          if (notificationId !== undefined) yield* notifier.notify(message, notificationId, "message")
          return message
        }),

      AskQuestion: ({ question, options, why, meanwhile }) =>
        Effect.gen(function* () {
          const current = yield* project
          const notificationId = yield* newNotificationId()
          const message = QuestionMessage.make({
            id: yield* newMessageId(),
            projectId: current.id,
            createdAt: yield* DateTime.now,
            notificationId,
            question,
            options,
            ...(why === undefined ? {} : { why }),
            ...(meanwhile === undefined ? {} : { meanwhile }),
            state: QuestionState.cases.Open.make({})
          })
          yield* core.addMessage(message)
          yield* notifier.notify(message, notificationId, "question")
          yield* notifier.asksChanged
          return message
        }),

      WithdrawQuestion: ({ messageId }) =>
        Effect.gen(function* () {
          const message = yield* findMessage(messageId)
          if (message._tag !== "Question") return yield* notFound("question", messageId)
          if (message.state._tag === "Withdrawn") return message
          if (message.state._tag === "Answered") {
            return yield* new InvalidRequest({ message: "They already answered this question." })
          }
          const withdrawn = QuestionMessage.make({
            ...message,
            state: QuestionState.cases.Withdrawn.make({ withdrawnAt: yield* DateTime.now })
          })
          yield* core.changeMessage(withdrawn)
          yield* notifier.withdrawFor(withdrawn)
          yield* notifier.asksChanged
          return withdrawn
        }),

      RequestAccess: ({ request, why, when }) =>
        Effect.gen(function* () {
          const current = yield* project
          const notificationId = when === undefined ? yield* newNotificationId() : undefined
          const message = AccessMessage.make({
            id: yield* newMessageId(),
            projectId: current.id,
            createdAt: yield* DateTime.now,
            ...(notificationId === undefined ? {} : { notificationId }),
            request,
            why,
            ...(when === undefined ? {} : { when }),
            state: AccessState.cases.Open.make({})
          })
          yield* core.addMessage(message)
          if (notificationId !== undefined) yield* notifier.notify(message, notificationId, "access")
          yield* notifier.asksChanged
          return message
        }),

      // Answered by the Worker from D1; the DO never sees these.
      ListAccess: () => Effect.die("ListAccess is served by the Worker"),
      GetUsage: () => Effect.die("GetUsage is served by the Worker"),
      CreateMediaUpload: () => Effect.die("CreateMediaUpload is served by the Worker"),

      WithdrawNotification: ({ notificationId }) =>
        Effect.gen(function* () {
          const record = yield* store.notification(notificationId)
          if (Option.isNone(record)) return yield* notFound("notification", notificationId)
          yield* notifier.withdraw([notificationId])
          if (record.value.messageId !== undefined) {
            const message = yield* core.message(record.value.messageId)
            if (Option.isSome(message)) yield* core.changeMessage(message.value)
          }
        }),

      GetStatus: () => core.status,

      UpdateStatus: (patch) =>
        Effect.gen(function* () {
          const current = yield* project
          const now = yield* DateTime.now
          let status = yield* core.status
          if (patch.phase !== undefined && patch.phase !== status.phase)
            status = { ...status, phase: patch.phase, phaseSince: now }
          status = patchStatus(status, "now", patch.now)
          status = patchStatus(status, "justDid", patch.justDid)
          status = patchStatus(status, "next", patch.next)
          if (patch.media !== undefined) status = { ...status, media: yield* resolveMedia(patch.media) }
          if (patch.milestones !== undefined) status = { ...status, milestones: patch.milestones }
          status = { ...status, updatedAt: now }

          const headline = status.now ?? status.justDid
          const { kind: _k, icon: _i, headline: _h, ...base } = current
          const next = {
            ...base,
            ...(patch.title === undefined ? {} : { title: patch.title }),
            phase: status.phase,
            ...(headline === undefined ? {} : { headline }),
            ...(patch.kind === undefined
              ? current.kind === undefined
                ? {}
                : { kind: current.kind }
              : patch.kind === null
                ? {}
                : { kind: patch.kind }),
            ...(patch.icon === undefined
              ? current.icon === undefined
                ? {}
                : { icon: current.icon }
              : patch.icon === null
                ? {}
                : { icon: patch.icon }),
            updatedAt: now
          }
          yield* core.saveStatus(status)
          yield* core.saveProject(next)
          return status
        }),

      StartLiveActivity: ({ content }) => notifier.startLive(content),
      UpdateLiveActivity: ({ content }) => notifier.updateLive(content),
      EndLiveActivity: ({ content }) => notifier.endLive(content),

      ScheduleWake: ({ when, why, run }) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          if (when._tag === "Cron" && Result.isFailure(Cron.parse(when.expression, when.timeZone ?? "UTC"))) {
            return yield* new InvalidRequest({
              message: `"${when.expression}" isn't a valid five-field cron expression.`
            })
          }
          const next = nextWakeAt(when, yield* timeZone, nowMs)
          if (Option.isNone(next)) return yield* new InvalidRequest({ message: "That time has already passed." })
          const wake: Wake = {
            id: yield* newWakeId(),
            when,
            why,
            ...(run === undefined ? {} : { run }),
            nextAt: DateTime.makeUnsafe(next.value),
            createdAt: DateTime.makeUnsafe(nowMs)
          }
          yield* store.putWake(wake, next.value)
          yield* alarm.reschedule
          return wake
        }),

      ListWakes: () => store.wakes,

      CancelWake: ({ wakeId }) =>
        Effect.gen(function* () {
          const wake = yield* store.wake(wakeId)
          if (Option.isNone(wake)) return yield* notFound("wake", wakeId)
          yield* store.deleteWake(wakeId)
          yield* alarm.reschedule
        }),

      WakeNow: ({ why }) =>
        Effect.gen(function* () {
          yield* core.enqueue(
            AgentEvent.cases.Alert.make({ id: yield* newEventId(), at: yield* DateTime.now, reason: why })
          )
        }),

      Publish: ({ port }) =>
        Effect.gen(function* () {
          if (port === DefaultDaemonPort) {
            return yield* new InvalidRequest({
              message: `Port ${port} is dreamd's; publish the port your app listens on.`
            })
          }
          const current = yield* project
          if (current.publishedPort !== port) {
            yield* core.saveProject({ ...current, publishedPort: port, updatedAt: yield* DateTime.now })
          }
          return { url: current.publicUrl }
        }),

      StartBrowser: () => machines.startBrowser,
      StopBrowser: ({ sessionId }) => machines.stopBrowser(sessionId),
      GetBrowserRecording: ({ sessionId }) => machines.browserRecording(sessionId),
      StartMac: () => machines.startMac,
      GetMac: () => machines.mac,
      GetMacSsh: () => machines.macSsh,
      StopMac: () => machines.stopMac,

      ReportUsage: ({ usage }) =>
        Effect.gen(function* () {
          const current = yield* project
          yield* connections.recordUsage(current.ownerId, usage)
          if (usage.limitedUntil === undefined) return
          const { window, until } = usage.limitedUntil
          if (DateTime.toEpochMillis(until) <= (yield* Clock.currentTimeMillis)) return
          yield* core.saveUsagePause(Option.some({ window, until, wakeOnReset: true }))
          yield* store.setTimer("usage-reset", DateTime.toEpochMillis(until))
          yield* alarm.reschedule
          yield* directory.usageLimited(current.ownerId, window, until, current.id).pipe(Effect.forkDetach)
        }),

      ReportTurn: ({ state }) => (state === "started" ? sandbox.turnStarted : sandbox.turnFinished)
    }
  })
)

export const LiveHandlers = ProjectLiveRpcs.toLayer(
  Effect.gen(function* () {
    const live = yield* LiveFeed
    const core = yield* Core
    return { Subscribe: () => live.subscribe(core.snapshot) }
  })
)
