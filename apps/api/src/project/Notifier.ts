/**
 * Everything this project puts on their phone outside the app: alert
 * notifications for messages, questions and access requests; silent pushes
 * that withdraw stale ones; and the Live Activity.
 */
import {
  type AskMessage,
  InvalidRequest,
  type LiveActivityContent,
  type Message,
  type NotificationCategory,
  type NotificationId,
  PushData,
  UpstreamFailure
} from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option } from "effect"
import { Projects } from "../db/Projects.ts"
import { Users } from "../db/Users.ts"
import { Apns, type PushResult } from "../push/Apns.ts"
import { Core } from "./Core.ts"
import { type LiveActivityRecord, Singletons, Store } from "./Store.ts"

/** Plain text for a notification body: no markdown punctuation, at most ~180 characters. */
export const notificationText = (markdown: string): string => {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return plain.length > 180 ? `${plain.slice(0, 177).trimEnd()}…` : plain
}

const askPrompt = (ask: AskMessage): string => (ask._tag === "Question" ? ask.question : ask.why)

const DismissAfterEndSeconds = 60 * 60

export class Notifier extends Context.Service<
  Notifier,
  {
    /** Sends an alert about `message` to every device, as notification `id`. */
    readonly notify: (message: Message, id: NotificationId, category: NotificationCategory) => Effect.Effect<void>
    readonly withdraw: (ids: ReadonlyArray<NotificationId>) => Effect.Effect<void>
    /** Withdraws every notification sent for a message (answered, withdrawn, connected, declined). */
    readonly withdrawFor: (message: Message) => Effect.Effect<void>

    readonly startLive: (content: LiveActivityContent) => Effect.Effect<void, UpstreamFailure>
    readonly updateLive: (content: LiveActivityContent) => Effect.Effect<void, InvalidRequest | UpstreamFailure>
    readonly endLive: (content: LiveActivityContent | undefined) => Effect.Effect<void, UpstreamFailure>
    readonly registerLive: (device: {
      readonly deviceId: string
      readonly activityId: string
      readonly pushToken: string
    }) => Effect.Effect<void>
    /** Open asks changed: switch the running activity in or out of "Needs you". */
    readonly asksChanged: Effect.Effect<void>
  }
>()("@dream/api/project/Notifier") {
  static readonly layer = Layer.effect(
    Notifier,
    Effect.gen(function* () {
      const core = yield* Core
      const store = yield* Store
      const users = yield* Users
      const projects = yield* Projects
      const apns = yield* Apns

      const devices = Effect.flatMap(core.project.pipe(Effect.orDie), (project) => users.devices(project.ownerId))

      const forget = (token: string, kind: "apns" | "start") => (result: PushResult) =>
        result === "unregistered"
          ? kind === "apns"
            ? users.forgetApnsToken(token)
            : users.forgetPushToStartToken(token)
          : Effect.void

      const notify = Effect.fn("Notifier.notify")(function* (
        message: Message,
        id: NotificationId,
        category: NotificationCategory
      ) {
        const project = yield* core.project.pipe(Effect.orDie)
        const now = yield* DateTime.now
        yield* store.putNotification({ id, messageId: message.id, sentAt: now })
        yield* projects.recordNotification({
          id,
          userId: project.ownerId,
          projectId: project.id,
          messageId: message.id,
          sentAt: now
        })
        const body =
          message._tag === "Text"
            ? notificationText(message.text)
            : message._tag === "Question"
              ? notificationText(message.question)
              : notificationText(message.why)
        for (const device of yield* devices) {
          if (device.apnsToken === undefined) continue
          const token = device.apnsToken
          yield* apns
            .alert(token, {
              id,
              title: project.title,
              body,
              category,
              threadId: project.id,
              data: PushData.cases.OpenMessage.make({
                projectId: project.id,
                messageId: message.id,
                notificationId: id
              })
            })
            .pipe(
              Effect.flatMap(forget(token, "apns")),
              Effect.catch((error) => Effect.logWarning("APNs alert failed", error.message))
            )
        }
      })

      const withdraw = Effect.fn("Notifier.withdraw")(function* (ids: ReadonlyArray<NotificationId>) {
        if (ids.length === 0) return
        const now = yield* DateTime.now
        const withdrawn: Array<NotificationId> = []
        for (const id of ids) {
          const record = yield* store.notification(id)
          if (Option.isNone(record) || record.value.withdrawnAt !== undefined) continue
          yield* store.putNotification({ ...record.value, withdrawnAt: now })
          withdrawn.push(id)
        }
        if (withdrawn.length === 0) return
        yield* projects.withdrawNotifications(withdrawn, now)
        const data = PushData.cases.Withdraw.make({
          notificationIds: withdrawn as [NotificationId, ...Array<NotificationId>]
        })
        for (const device of yield* devices) {
          if (device.apnsToken === undefined) continue
          const token = device.apnsToken
          yield* apns.silent(token, data).pipe(
            Effect.flatMap(forget(token, "apns")),
            Effect.catch((error) => Effect.logWarning("APNs withdraw failed", error.message))
          )
        }
      })

      const withdrawFor = (message: Message) =>
        Effect.flatMap(store.notificationsFor(message.id), (records) =>
          withdraw(records.filter((r) => r.withdrawnAt === undefined).map((r) => r.id))
        )

      // Live Activity -----------------------------------------------------------

      const liveRecord = store.getSingleton(...Singletons.liveActivity)
      const saveLive = (record: LiveActivityRecord) => store.putSingleton(...Singletons.liveActivity, record)

      /** The content as shown: the agent's, plus "Needs you" while an ask is open. */
      const shown = (content: LiveActivityContent) =>
        Effect.map(core.openAsks, (asks): LiveActivityContent => {
          const { needsYou: _, ...rest } = content
          const first = asks[0]
          if (first === undefined) return rest
          const prompt = askPrompt(first)
          return { ...rest, needsYou: { prompt: prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt } }
        })

      const pushToActivities = (record: LiveActivityRecord, content: LiveActivityContent, urgent: boolean) =>
        Effect.forEach(
          record.activities,
          (activity) =>
            apns
              .liveActivity(activity.pushToken, { event: "update", content, urgent })
              .pipe(Effect.catch((error) => Effect.logWarning("Live Activity update failed", error.message))),
          { discard: true }
        )

      const endActivities = (record: LiveActivityRecord, content: LiveActivityContent | undefined) =>
        Effect.forEach(
          record.activities,
          (activity) =>
            apns
              .liveActivity(activity.pushToken, { event: "end", content, dismissAfterSeconds: DismissAfterEndSeconds })
              .pipe(Effect.catch((error) => Effect.logWarning("Live Activity end failed", error.message))),
          { discard: true }
        )

      const startLive = Effect.fn("Notifier.startLive")(function* (content: LiveActivityContent) {
        const project = yield* core.project.pipe(Effect.orDie)
        const existing = yield* liveRecord
        if (Option.isSome(existing) && !existing.value.ended) yield* endActivities(existing.value, undefined)
        const attributes = {
          projectId: project.id,
          projectName: project.title,
          ...(project.icon === undefined ? {} : { icon: project.icon })
        }
        yield* saveLive({ attributes, content, startedAt: yield* DateTime.now, ended: false, activities: [] })
        const visible = yield* shown(content)
        let attempted = 0
        let lastError: UpstreamFailure | undefined
        for (const device of yield* devices) {
          if (device.pushToStartToken === undefined) continue
          attempted++
          const token = device.pushToStartToken
          yield* apns
            .liveActivity(token, {
              event: "start",
              attributes,
              content: visible,
              alert: { title: project.title, body: visible.title }
            })
            .pipe(
              Effect.flatMap(forget(token, "start")),
              Effect.catch((error) => Effect.sync(() => void (lastError = error)))
            )
        }
        if (attempted > 0 && lastError !== undefined) return yield* lastError
      })

      const updateLive = Effect.fn("Notifier.updateLive")(function* (content: LiveActivityContent) {
        const record = yield* liveRecord
        if (Option.isNone(record) || record.value.ended) {
          return yield* new InvalidRequest({
            message: "No Live Activity is running. Start one with `dream live start`."
          })
        }
        yield* saveLive({ ...record.value, content })
        yield* pushToActivities(record.value, yield* shown(content), false)
      })

      const endLive = Effect.fn("Notifier.endLive")(function* (content: LiveActivityContent | undefined) {
        const record = yield* liveRecord
        if (Option.isNone(record) || record.value.ended) return
        yield* saveLive({ ...record.value, ...(content === undefined ? {} : { content }), ended: true })
        yield* endActivities(record.value, content === undefined ? undefined : yield* shown(content))
      })

      const registerLive = Effect.fn("Notifier.registerLive")(function* (device: {
        readonly deviceId: string
        readonly activityId: string
        readonly pushToken: string
      }) {
        const record = yield* liveRecord
        if (Option.isNone(record)) return
        const activities = [
          ...record.value.activities.filter(
            (a) => a.deviceId !== device.deviceId && a.activityId !== device.activityId
          ),
          device
        ]
        const next = { ...record.value, activities }
        yield* saveLive(next)
        if (record.value.ended) {
          yield* endActivities({ ...next, activities: [device] }, undefined)
        } else {
          yield* pushToActivities({ ...next, activities: [device] }, yield* shown(next.content), false)
        }
      })

      const asksChanged = Effect.gen(function* () {
        const record = yield* liveRecord
        if (Option.isNone(record) || record.value.ended) return
        const visible = yield* shown(record.value.content)
        yield* pushToActivities(record.value, visible, visible.needsYou !== undefined)
      })

      return Notifier.of({ notify, withdraw, withdrawFor, startLive, updateLive, endLive, registerLive, asksChanged })
    })
  )
}
