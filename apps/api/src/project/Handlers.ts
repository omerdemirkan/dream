/**
 * The ProjectDO's RPC handlers: `ProjectRpcs` (the Worker acting for the
 * phone, OAuth callbacks and crons) and `SandboxRpcs` (the agent, through
 * dreamd and the Worker), plus `ProjectLiveRpcs` for the phone's socket.
 */
import {
  accessHostProblem,
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
  type QuestionAnswer,
  QuestionMessage,
  type QuestionPreview,
  questionPreviewsProblem,
  QuestionState,
  SandboxAuth,
  SandboxRpcs,
  type StatusCard,
  TextMessage,
  type Wake,
  type WakeWhen,
  DefaultDaemonPort,
  keyFileNameProblem,
  waitsOnThem,
  type Workstream,
  type WorkstreamId,
  type Workstreams
} from "@dream/domain"
import { Clock, Cron, DateTime, Effect, Layer, Option, Result } from "effect"
import { Connections } from "../db/Connections.ts"
import { Secrets } from "../db/Secrets.ts"
import { Projects } from "../db/Projects.ts"
import { Users } from "../db/Users.ts"
import { CredentialStore } from "../integrations/CredentialStore.ts"
import { newEventId, newMessageId, newNotificationId, newWakeId, newWorkstreamId } from "../lib/Ids.ts"
import { Alarm } from "./Alarm.ts"
import { AppNotifications } from "./AppNotifications.ts"
import { ProjectDirectory } from "./Client.ts"
import { Core, initialStatus } from "./Core.ts"
import { LiveFeed } from "./Live.ts"
import { Machines } from "./Machines.ts"
import { Notifier } from "./Notifier.ts"
import { ProjectRpcs } from "./ProjectRpcs.ts"
import { Relays } from "./Relays.ts"
import { SandboxManager } from "./SandboxManager.ts"
import { type SandboxRecord, Singletons, Store } from "./Store.ts"

const notFound = (entity: string, id: string) => new NotFound({ entity, id })

const sameAnswer = (a: QuestionAnswer, b: QuestionAnswer) =>
  a._tag === "Choice"
    ? b._tag === "Choice" && a.option === b.option && a.note === b.note
    : b._tag === "Freeform" && a.text === b.text

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

/**
 * Whether the dreamd that will get the next delivery knows `AgentEvent.AccessRemoved`. Builds that report a release
 * (sandbox refresh) all do; an older one is still in a ready sandbox that predates them. The next sandbox comes from
 * the current template.
 */
export const knowsAccessRemoved = (record: SandboxRecord): boolean =>
  record.status !== "ready" || record.release !== undefined

/** Ended workstreams the card keeps, latest first, so the list stays small in a project that lives for months. */
export const EndedWorkstreamsKept = 30

/** `list` with the oldest ended ones past `EndedWorkstreamsKept` let go. */
export const pruneWorkstreams = (list: ReadonlyArray<Workstream>): ReadonlyArray<Workstream> => {
  const ended = list
    .filter((w) => w.state !== "active")
    .sort((a, b) => DateTime.toEpochMillis(b.endedAt ?? b.updatedAt) - DateTime.toEpochMillis(a.endedAt ?? a.updatedAt))
  const gone = new Set(ended.slice(EndedWorkstreamsKept).map((w) => w.id))
  return list.filter((w) => !gone.has(w.id))
}

/** The workstreams, and which wait on them because one of their questions or access requests is open. */
export const workstreamsOf = (status: StatusCard, openAsks: ReadonlyArray<Message>): Workstreams => ({
  workstreams: status.workstreams ?? [],
  waiting: openAsks.flatMap((m) =>
    m.workstream !== undefined && waitsOnThem(m) ? [{ workstream: m.workstream, messageId: m.id }] : []
  )
})

export const ProjectHandlers = ProjectRpcs.toLayer(
  Effect.gen(function* () {
    const core = yield* Core
    const store = yield* Store
    const notifier = yield* Notifier
    const sandbox = yield* SandboxManager
    const credentials = yield* CredentialStore
    const connections = yield* Connections
    const secrets = yield* Secrets
    const directory = yield* ProjectDirectory
    const alarm = yield* Alarm
    const projects = yield* Projects
    const machines = yield* Machines
    const relays = yield* Relays
    const appNotifications = yield* AppNotifications

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
      Init: ({ project, attachments }) =>
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
            media: [],
            ...(attachments === undefined || attachments.length === 0 ? {} : { attachments })
          })
          yield* core.addMessage(first)
          yield* core.enqueue(
            yield* event((fields) =>
              AgentEvent.cases.UserMessage.make({
                ...fields,
                messageId: first.id,
                text: project.idea,
                ...(first.attachments === undefined ? {} : { attachments: first.attachments })
              })
            )
          )
          return project
        }),

      GetProject: () => core.project,

      ListMessages: ({ before, limit }) => store.messagesBefore(before, limit),

      SendUserMessage: ({ text, id, workstream, attachments }) =>
        Effect.gen(function* () {
          if (id !== undefined) {
            const posted = yield* core.message(id)
            if (Option.isSome(posted) && posted.value._tag === "Text") return posted.value
          }
          const project = yield* core.project.pipe(Effect.orDie)
          // A workstream the agent has since let go of, or never had, is left off rather than refusing their words.
          const into =
            workstream === undefined ? undefined : (yield* core.status).workstreams?.find((w) => w.id === workstream)
          const message = TextMessage.make({
            id: id ?? (yield* newMessageId()),
            projectId: project.id,
            createdAt: yield* DateTime.now,
            from: "user",
            text,
            media: [],
            ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
            ...(into === undefined ? {} : { workstream: into.id })
          })
          yield* core.addMessage(message)
          yield* core.enqueue(
            yield* event((fields) =>
              AgentEvent.cases.UserMessage.make({
                ...fields,
                messageId: message.id,
                text,
                ...(into === undefined ? {} : { workstream: { id: into.id, title: into.title } }),
                ...(message.attachments === undefined ? {} : { attachments: message.attachments })
              })
            )
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
          // The same answer again (a retry after a lost response) changes nothing and doesn't wake the agent twice.
          if (previous !== undefined && sameAnswer(previous, answer)) return message
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

      GetAccess: ({ messageId }) => findAccess(messageId),

      AccessConnected: ({ messageId, integration }) =>
        Effect.gen(function* () {
          const message = yield* findAccess(messageId)
          // A retry, or a second sign-in through the same card: the agent already heard.
          if (message.state._tag === "Connected" && message.state.integrationId === integration.id) return message
          const connected = AccessMessage.make({
            ...message,
            state: AccessState.cases.Connected.make({ integrationId: integration.id, connectedAt: yield* DateTime.now })
          })
          yield* core.changeMessage(connected)
          if (integration.access._tag === "File") yield* sandbox.keyFilesChanged
          yield* relays.integrationChanged(integration)
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

      DeclineAccess: ({ messageId, reason }) =>
        Effect.gen(function* () {
          const message = yield* findAccess(messageId)
          if (message.request._tag === "Notifications") return yield* appNotifications.decline(message, reason)
          if (message.state._tag === "Declined") return message
          if (message.state._tag !== "Open") {
            return yield* new InvalidRequest({ message: "This access request isn't open anymore." })
          }
          const declined = AccessMessage.make({
            ...message,
            state: AccessState.cases.Declined.make({
              declinedAt: yield* DateTime.now,
              ...(reason === undefined ? {} : { reason })
            })
          })
          yield* core.changeMessage(declined)
          yield* core.enqueue(
            yield* event((fields) =>
              AgentEvent.cases.AccessDeclined.make({
                ...fields,
                messageId,
                ...(reason === undefined ? {} : { reason })
              })
            )
          )
          yield* notifier.withdrawFor(declined)
          yield* notifier.asksChanged
          return declined
        }),

      GetAppNotifications: () => appNotifications.list(undefined),
      AllowAppNotifications: ({ messageId }) =>
        Effect.gen(function* () {
          const message = yield* findAccess(messageId)
          if (message.request._tag !== "Notifications") return yield* notFound("notifications request", messageId)
          return yield* appNotifications.allow(message)
        }),
      UpdateAppNotifications: ({ app, delivery, mutedUntil }) => appNotifications.update(app, { delivery, mutedUntil }),
      OpenedAppNotification: ({ notificationId }) => appNotifications.opened(notificationId),

      RegisterLiveActivity: (device) => notifier.registerLive(device),

      IntegrationGone: ({ integration, failure }) =>
        Effect.gen(function* () {
          if (Option.isSome(yield* store.getSingleton(...Singletons.deleted))) return
          const now = yield* DateTime.now
          const cards = (yield* store.accessMessagesFor(integration.id)).filter(
            (message) => message.state._tag === "Connected"
          )
          for (const card of cards) {
            yield* core.changeMessage(
              AccessMessage.make({
                ...card,
                state: AccessState.cases.Disconnected.make({
                  integrationId: integration.id,
                  disconnectedAt: now,
                  reason: failure === undefined ? "removed" : "failed"
                })
              })
            )
          }
          yield* relays.integrationChanged(integration)
          const removed = AgentEvent.cases.AccessRemoved.make({
            id: yield* newEventId(),
            at: now,
            label: integration.label,
            access: integration.access,
            ...(failure === undefined ? {} : { failure })
          })
          if (integration.access._tag === "File") {
            yield* sandbox.keyFilesChanged
            return yield* core.enqueue(removed)
          }
          yield* sandbox.refreshRules
          // Projects that never asked for it don't hear, and neither does a dreamd too old to know the event.
          if (cards.length > 0 && (integration.access._tag === "OAuth" || knowsAccessRemoved(yield* core.sandbox))) {
            yield* core.enqueue(removed)
          }
        }),

      IntegrationRestored: ({ integration, tell }) =>
        Effect.gen(function* () {
          if (Option.isSome(yield* store.getSingleton(...Singletons.deleted))) return
          const now = yield* DateTime.now
          const cards = (yield* store.accessMessagesFor(integration.id)).filter(
            (message) => message.state._tag === "Disconnected" && message.state.reason === "failed"
          )
          for (const card of cards) {
            yield* core.changeMessage(
              AccessMessage.make({
                ...card,
                state: AccessState.cases.Connected.make({ integrationId: integration.id, connectedAt: now })
              })
            )
          }
          yield* relays.integrationChanged(integration)
          const last = cards.at(-1)
          if (!tell || last === undefined) return
          yield* core.enqueue(
            AgentEvent.cases.AccessConnected.make({
              id: yield* newEventId(),
              at: now,
              messageId: last.id,
              label: integration.label,
              access: integration.access,
              change: "restored"
            })
          )
        }),

      LinkEdited: (payload) =>
        Effect.gen(function* () {
          if (Option.isSome(yield* store.getSingleton(...Singletons.deleted))) return
          yield* core.enqueue(yield* event((fields) => AgentEvent.cases.LinkEdited.make({ ...fields, ...payload })))
        }),

      KeyFileReplaced: ({ integration }) =>
        Effect.gen(function* () {
          if (Option.isSome(yield* store.getSingleton(...Singletons.deleted))) return
          yield* sandbox.keyFilesChanged
          // The event names the request it was connected through, which every file key has.
          const card = (yield* store.accessMessagesFor(integration.id)).at(-1)
          if (card === undefined) return
          yield* core.enqueue(
            yield* event((fields) =>
              AgentEvent.cases.AccessConnected.make({
                ...fields,
                messageId: card.id,
                label: integration.label,
                access: integration.access,
                change: "replaced"
              })
            )
          )
        }),

      CredentialsChanged: () => Effect.andThen(sandbox.refreshRules, relays.keysChanged),

      UsageLimited: ({ window, until }) =>
        Effect.gen(function* () {
          const current = yield* core.usagePause
          const wakeOnReset = Option.isSome(current) && current.value.wakeOnReset
          yield* core.saveUsagePause(Option.some({ window, until, wakeOnReset }))
          yield* store.setTimer("usage-reset", DateTime.toEpochMillis(until))
          yield* alarm.reschedule
        }),

      GatewayTarget: () => sandbox.gatewayTarget,

      RelayDeliver: ({ relayId, deliveries }) => relays.deliver(relayId, deliveries),
      RelayCredential: ({ relayId }) => relays.credential(relayId),
      RelayAlert: ({ relayId, reason }) => relays.alert(relayId, reason),
      RelayActive: ({ relayId }) => relays.active(relayId),

      Delete: () =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          // First, so everything after this (dreamd, the alarm, a delivery under way) finds it deleted.
          yield* store.putSingleton(...Singletons.deleted, { at: now })
          yield* store.clearSchedule(DateTime.formatIso(now))
          yield* alarm.reschedule
          yield* relays.stopAll
          yield* sandbox.destroy
          yield* machines.stopMac.pipe(
            Effect.catch((error) => Effect.logWarning("couldn't stop the deleted project's Mac", error.message))
          )
          const current = yield* core.projectOption
          if (Option.isSome(current)) {
            yield* notifier.withdraw(yield* store.unwithdrawnNotifications)
            yield* notifier
              .endLive(undefined)
              .pipe(Effect.catch((error) => Effect.logWarning("couldn't end the Live Activity", error.message)))
            // Its file keys were for this project alone, and the sandbox that held them is gone.
            for (const row of yield* connections.integrations(current.value.ownerId)) {
              if (row.access_json._tag !== "File" || row.access_json.projectId !== current.value.id) continue
              yield* connections.deleteIntegration(row.id)
              yield* secrets.remove(row.secret_id)
            }
            yield* projects.remove(current.value.id)
          }
          yield* store.wipe
        }),

      Archive: () =>
        Effect.gen(function* () {
          const project = yield* core.project.pipe(Effect.orDie)
          const existing = yield* store.getSingleton(...Singletons.archived)
          if (Option.isSome(existing)) return existing.value.at
          const at = yield* DateTime.now
          yield* store.putSingleton(...Singletons.archived, { at })
          yield* projects.setArchived(project.id, at)
          yield* relays.stopAll
          yield* sandbox.pause
          // Nothing will use a Mac it rented; don't leave it running until it idles out.
          yield* machines.stopMac.pipe(
            Effect.catch((error) => Effect.logWarning("couldn't stop the archived project's Mac", error.message))
          )
          // A lock screen saying the agent is at work would be wrong from now on.
          yield* notifier
            .endLive(undefined)
            .pipe(Effect.catch((error) => Effect.logWarning("couldn't end the Live Activity", error.message)))
          return at
        }),

      Restore: () =>
        Effect.gen(function* () {
          const project = yield* core.project.pipe(Effect.orDie)
          if (Option.isNone(yield* store.getSingleton(...Singletons.archived))) return
          yield* store.clearSingleton(Singletons.archived[0])
          yield* projects.setArchived(project.id, undefined)
          yield* sandbox.restored
          yield* relays.startAll
        }),

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
    const relays = yield* Relays
    const appNotifications = yield* AppNotifications

    const project = core.project.pipe(Effect.orDie)

    /**
     * This project's uploads, by id. Audio is for a question's previews only (`allowAudio`): an app from before it
     * can't decode it, and a message or status card it can't read is one it can't show.
     */
    const resolveMedia = (ids: ReadonlyArray<MediaId>, allowAudio = false) =>
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
          if (row.value.ref_json.kind === "audio" && !allowAudio) {
            return yield* new InvalidRequest({
              message:
                "Audio plays only as an option's preview (`dream ask --show`), not in a message or the status card."
            })
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

    const findWorkstream = (id: WorkstreamId) =>
      Effect.gen(function* () {
        const status = yield* core.status
        const found = status.workstreams?.find((w) => w.id === id)
        if (found === undefined) return yield* notFound("workstream", id)
        return { status, workstream: found }
      })

    /** `--work`: the workstream has to be one of the project's. */
    const labelFor = (id: WorkstreamId | undefined) =>
      Effect.gen(function* () {
        if (id === undefined) return {}
        const status = yield* core.status
        if (status.workstreams?.some((w) => w.id === id) !== true) {
          return yield* new InvalidRequest({
            message: `This project has no workstream ${id}; \`dream work list\` shows the ones it has.`
          })
        }
        return { workstream: id }
      })

    const workstreams = Effect.gen(function* () {
      return workstreamsOf(yield* core.status, yield* core.openAsks)
    })

    /** Replaces one workstream (or adds it) and saves the card, which reaches the phone as `StatusChanged`. */
    const saveWorkstream = (status: StatusCard, next: Workstream) =>
      Effect.gen(function* () {
        const list = status.workstreams ?? []
        const replaced = list.some((w) => w.id === next.id)
          ? list.map((w) => (w.id === next.id ? next : w))
          : [...list, next]
        yield* core.saveStatus({ ...status, workstreams: pruneWorkstreams(replaced), updatedAt: next.updatedAt })
        return yield* workstreams
      })

    const route = (messageId: Message["id"], workstream: WorkstreamId) =>
      Effect.gen(function* () {
        const message = yield* findMessage(messageId)
        if (message.workstream === workstream) return message
        const routed = { ...message, workstream }
        yield* core.changeMessage(routed)
        return routed
      })

    return {
      ListWorkstreams: () => workstreams,

      StartWorkstream: ({ title, now, from }) =>
        Effect.gen(function* () {
          if (from !== undefined) yield* findMessage(from)
          const at = yield* DateTime.now
          const workstream: Workstream = {
            id: yield* newWorkstreamId(),
            title: title.trim(),
            ...(now === undefined || now.trim() === "" ? {} : { now: now.trim() }),
            state: "active",
            startedAt: at,
            updatedAt: at
          }
          const report = yield* saveWorkstream(yield* core.status, workstream)
          if (from !== undefined) yield* route(from, workstream.id)
          return report
        }),

      UpdateWorkstream: ({ workstreamId, title, now }) =>
        Effect.gen(function* () {
          const { status, workstream } = yield* findWorkstream(workstreamId)
          const { now: _, ...rest } = workstream
          const nextNow =
            now === undefined ? workstream.now : now === null || now.trim() === "" ? undefined : now.trim()
          return yield* saveWorkstream(status, {
            ...rest,
            ...(title === undefined ? {} : { title: title.trim() }),
            ...(nextNow === undefined ? {} : { now: nextNow }),
            updatedAt: yield* DateTime.now
          })
        }),

      EndWorkstream: ({ workstreamId, state, result }) =>
        Effect.gen(function* () {
          const { status, workstream } = yield* findWorkstream(workstreamId)
          if (workstream.state === state) return yield* workstreams
          const at = yield* DateTime.now
          const { result: _, ...rest } = workstream
          return yield* saveWorkstream(status, {
            ...rest,
            state,
            ...(result === undefined || result.trim() === "" ? {} : { result: result.trim() }),
            updatedAt: at,
            endedAt: at
          })
        }),

      RouteMessage: ({ messageId, workstreamId }) =>
        Effect.gen(function* () {
          yield* findWorkstream(workstreamId)
          return yield* route(messageId, workstreamId)
        }),

      SendMessage: ({ text, media, notify, workstream }) =>
        Effect.gen(function* () {
          const current = yield* project
          const label = yield* labelFor(workstream)
          const refs = yield* resolveMedia(media)
          const notificationId = notify ? yield* newNotificationId() : undefined
          const message = TextMessage.make({
            id: yield* newMessageId(),
            projectId: current.id,
            createdAt: yield* DateTime.now,
            from: "agent",
            text,
            media: refs,
            ...(notificationId === undefined ? {} : { notificationId }),
            ...label
          })
          yield* core.addMessage(message)
          if (notificationId !== undefined) yield* notifier.notify(message, notificationId, "message")
          return message
        }),

      AskQuestion: ({ question, options, why, context, meanwhile, previews, workstream }) =>
        Effect.gen(function* () {
          const current = yield* project
          const label = yield* labelFor(workstream)
          const problem = previews === undefined ? undefined : questionPreviewsProblem(options, previews)
          if (problem !== undefined) return yield* new InvalidRequest({ message: problem })
          // In the order of the options, whatever order the flags came in.
          const resolved: Array<QuestionPreview> = []
          for (const option of options) {
            const preview = previews?.find((p) => p.option === option)
            if (preview === undefined) continue
            const [first, ...rest] = yield* resolveMedia(preview.media, true)
            if (first !== undefined) resolved.push({ option, media: [first, ...rest] })
          }
          const notificationId = yield* newNotificationId()
          const message = QuestionMessage.make({
            id: yield* newMessageId(),
            projectId: current.id,
            createdAt: yield* DateTime.now,
            notificationId,
            question,
            options,
            ...(why === undefined ? {} : { why }),
            ...(context === undefined || context.trim() === "" ? {} : { context }),
            ...(meanwhile === undefined ? {} : { meanwhile }),
            ...(resolved.length === 0 ? {} : { previews: resolved }),
            state: QuestionState.cases.Open.make({}),
            ...label
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

      RequestAccess: ({ request, why, context, when, workstream }) =>
        Effect.gen(function* () {
          // An old dreamd doesn't check the host, and a card for a host no request goes to can never work.
          const problem =
            request._tag === "Key"
              ? accessHostProblem(request.host)
              : request._tag === "File"
                ? keyFileNameProblem(request.name)
                : undefined
          if (problem !== undefined) return yield* new InvalidRequest({ message: problem })
          if (request._tag === "Notifications") {
            return yield* new InvalidRequest({
              message: "An app asks to notify them with `dream notify setup`, not `dream access`."
            })
          }
          const current = yield* project
          const label = yield* labelFor(workstream)
          const notificationId = when === undefined ? yield* newNotificationId() : undefined
          const message = AccessMessage.make({
            id: yield* newMessageId(),
            projectId: current.id,
            createdAt: yield* DateTime.now,
            ...(notificationId === undefined ? {} : { notificationId }),
            request,
            why,
            ...(context === undefined || context.trim() === "" ? {} : { context }),
            ...(when === undefined ? {} : { when }),
            state: AccessState.cases.Open.make({}),
            ...label
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
      AddLink: () => Effect.die("AddLink is served by the Worker"),
      UpdateLink: () => Effect.die("UpdateLink is served by the Worker"),
      RemoveLink: () => Effect.die("RemoveLink is served by the Worker"),
      ListLinks: () => Effect.die("ListLinks is served by the Worker"),

      SetUpAppNotifications: (request) =>
        Effect.gen(function* () {
          yield* labelFor(request.workstream)
          return yield* appNotifications.setUp(request)
        }),
      SendAppNotification: (request) => appNotifications.send(request),
      ListAppNotifications: ({ app }) => appNotifications.list(app),

      WithdrawNotification: ({ notificationId }) =>
        Effect.gen(function* () {
          const record = yield* store.notification(notificationId)
          if (Option.isNone(record)) return yield* notFound("notification", notificationId)
          yield* notifier.withdraw([notificationId])
          yield* appNotifications.withdrawn(notificationId)
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

      ScheduleWake: ({ when, why, run, task }) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          if (run !== undefined && task !== undefined) {
            return yield* new InvalidRequest({ message: "A wake-up runs a command or a task, not both." })
          }
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
            ...(task === undefined ? {} : { task }),
            nextAt: DateTime.makeUnsafe(next.value),
            createdAt: DateTime.makeUnsafe(nowMs)
          }
          yield* store.putWake(wake, next.value)
          yield* alarm.reschedule
          yield* core.wakesChanged
          return wake
        }),

      ListWakes: () => store.wakes,

      CancelWake: ({ wakeId }) =>
        Effect.gen(function* () {
          const wake = yield* store.wake(wakeId)
          if (Option.isNone(wake)) return yield* notFound("wake", wakeId)
          yield* store.deleteWake(wakeId)
          yield* alarm.reschedule
          yield* core.wakesChanged
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
          yield* sandbox.usageReported(usage)
          if (usage.limitedUntil === undefined) return
          const { window, until } = usage.limitedUntil
          if (DateTime.toEpochMillis(until) <= (yield* Clock.currentTimeMillis)) return
          yield* core.saveUsagePause(Option.some({ window, until, wakeOnReset: true }))
          yield* store.setTimer("usage-reset", DateTime.toEpochMillis(until))
          yield* alarm.reschedule
          yield* directory.usageLimited(current.ownerId, window, until, current.id).pipe(Effect.forkDetach)
        }),

      AddRelay: ({ source, target, label }) => relays.add({ source, target, label }),
      ListRelays: () => relays.list,
      RemoveRelay: ({ relayId }) => relays.remove(relayId),
      RestartRelay: ({ relayId }) => relays.restart(relayId),

      ReportTask: (report) => sandbox.taskFinished(report),
      ReportTurn: ({ state, usage }) => (state === "started" ? sandbox.turnStarted : sandbox.turnFinished(usage)),
      ReportProgress: (report) => sandbox.reportProgress(report),
      StayAwake: () => sandbox.stayAwake,
      Sleep: ({ reason, checkedAt }) => sandbox.sleep(reason, checkedAt),
      GetMachine: () => sandbox.machine,
      MoveMachine: ({ to, why }) => sandbox.moveMachine(to, why)
    }
  })
)

export const LiveHandlers = ProjectLiveRpcs.toLayer(
  Effect.gen(function* () {
    const live = yield* LiveFeed
    const core = yield* Core
    const sandbox = yield* SandboxManager
    // dreamd reports what a turn is doing only while someone watches: it hears when the first phone comes and the
    // last one goes (forked, so the feed never waits on the sandbox).
    const watchersChanged = Effect.forkDetach(sandbox.watchersChanged)
    return {
      Subscribe: () => live.subscribe(core.snapshot, Effect.asVoid(watchersChanged))
    }
  })
)
