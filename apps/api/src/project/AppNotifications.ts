/**
 * Notifications from the project's apps (`@dream/domain` `AppNotifications.ts`): what an app the agent built tells
 * them on its own, under its own name, usually from a scheduled `--run` job while the agent sleeps.
 *
 * - `setUp` readies an app and puts its `Notifications` card in Chat; `allow` and `decline` are their answer.
 * - `send` decides what happens to each notification (`decideOutcome`): their choices for the app, Dream's limits,
 *   repeats. What reaches their phone goes out through the Notifier; what doesn't is kept in the history (held,
 *   muted) or dropped (repeats, apps they haven't allowed). None of it is an error of the app.
 * - `update` and `opened` are their controls and taps; the agent hears what they change, and once a day at most
 *   that an app is being held back.
 */
import {
  type AccessMessage,
  AccessMessage as AccessMessageSchema,
  AccessRequest,
  AccessState,
  AgentEvent,
  type AppDelivery,
  type AppId,
  type AppNotification,
  type AppNotificationLimit,
  AppNotificationLimits,
  type AppNotificationOutcome,
  type AppNotifications as AppNotificationsList,
  type AppSender,
  InvalidRequest,
  type LinkColor,
  type LinkIcon,
  type LogLevel,
  type Message,
  NotFound,
  reachedPhone,
  type WorkstreamId
} from "@dream/domain"
import { Context, DateTime, Duration, Effect, Layer, Option, Result } from "effect"
import { newEventId, newMessageId, newNotificationId } from "../lib/Ids.ts"
import { Core } from "./Core.ts"
import { Notifier } from "./Notifier.ts"
import { ProjectLog } from "./ProjectLog.ts"
import { Store } from "./Store.ts"

const hourMs = Duration.toMillis(Duration.hours(1))
const dayMs = Duration.toMillis(Duration.days(1))

// ---------------------------------------------------------------------------
// Decisions, kept pure for tests
// ---------------------------------------------------------------------------

/**
 * Where a tap goes: `url` as a page of the project's published URL (a path like `/today`, or a full URL there).
 * Anything else fails with the reason: a confused or misled job mustn't put a link to somewhere else on their lock
 * screen.
 */
export const resolveAppUrl = (publicUrl: string, url: string): Result.Result<string, string> => {
  const refuse = Result.fail(
    `--url has to be a page of this project's published URL, ${publicUrl}, or a path on it like /today. ` +
      "To send them somewhere else, link to a page of your app that links on."
  )
  let base: URL
  try {
    base = new URL(publicUrl)
  } catch {
    return refuse
  }
  let resolved: URL
  try {
    resolved = url.startsWith("/") && !url.startsWith("//") ? new URL(url, base) : new URL(url)
  } catch {
    return refuse
  }
  if (resolved.protocol !== "https:" || resolved.origin !== base.origin) return refuse
  return Result.succeed(resolved.href)
}

/**
 * What happens to a notification from `sender`, given what its project's apps already sent in the last day
 * (`recent`, newest first, every kept outcome). Checked in order: their permission, repeats, their Off and Mute,
 * Dream's limits (only what reached their phone counts), then quiet.
 */
export const decideOutcome = (input: {
  readonly sender: AppSender
  readonly title: string | undefined
  readonly text: string
  readonly quiet: boolean
  readonly nowMs: number
  readonly recent: ReadonlyArray<AppNotification>
}): { readonly outcome: AppNotificationOutcome; readonly held?: AppNotificationLimit } => {
  const { sender, nowMs } = input
  if (sender.state._tag === "Waiting") return { outcome: "waiting" }
  if (sender.state._tag === "Declined") return { outcome: "declined" }
  const ownRecent = input.recent.filter((n) => n.app === sender.id)
  const since = (n: AppNotification, ms: number) => DateTime.toEpochMillis(n.sentAt) >= nowMs - ms
  const repeatMs = AppNotificationLimits.repeatHours * hourMs
  if (ownRecent.some((n) => since(n, repeatMs) && n.title === input.title && n.text === input.text)) {
    return { outcome: "duplicate" }
  }
  const muted =
    sender.delivery === "off" || (sender.mutedUntil !== undefined && DateTime.toEpochMillis(sender.mutedUntil) > nowMs)
  if (muted) return { outcome: "muted" }
  const pushed = (list: ReadonlyArray<AppNotification>, ms: number) =>
    list.filter((n) => reachedPhone(n.outcome) && since(n, ms)).length
  if (pushed(ownRecent, hourMs) >= AppNotificationLimits.perAppHour) return { outcome: "held", held: "hour" }
  if (pushed(ownRecent, dayMs) >= AppNotificationLimits.perAppDay) return { outcome: "held", held: "day" }
  if (pushed(input.recent, dayMs) >= AppNotificationLimits.perProjectDay) return { outcome: "held", held: "project" }
  return { outcome: input.quiet || sender.delivery === "quiet" ? "quiet" : "sent" }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface SetUpRequest {
  readonly app: AppId
  readonly name: string
  readonly why: string
  readonly often: string
  readonly icon?: LinkIcon | undefined
  readonly color?: LinkColor | undefined
  readonly url?: string | undefined
  readonly workstream?: WorkstreamId | undefined
}

export interface SendRequest {
  readonly app: AppId
  readonly text: string
  readonly title?: string | undefined
  readonly url?: string | undefined
  readonly key?: string | undefined
  readonly quiet: boolean
  readonly dryRun: boolean
}

/** What became of a notification an app sent, as the log says it. */
const notifyOutcome = (
  outcome: AppNotificationOutcome,
  held: AppNotificationLimit | undefined,
  delivered: { readonly devices: number; readonly failures: ReadonlyArray<string> } | undefined
): string => {
  const reached =
    delivered === undefined
      ? ""
      : delivered.devices === 0
        ? delivered.failures.length === 0
          ? ", but they have no iPhone that takes notifications"
          : `, but no iPhone took it (${delivered.failures.join("; ")})`
        : `, to ${delivered.devices === 1 ? "their iPhone" : `${delivered.devices} iPhones`}` +
          (delivered.failures.length === 0 ? "" : `; failed for ${delivered.failures.join("; ")}`)
  switch (outcome) {
    case "sent":
      return `sent${reached}`
    case "quiet":
      return `sent quietly${reached}`
    case "held":
      return `held back: over Dream's ${held === "project" ? "daily limit for the project" : `${held ?? "hourly"} limit for the app`}`
    case "muted":
      return "kept in its history: they muted it"
    case "duplicate":
      return "not sent: the same as one it just sent"
    case "waiting":
      return "kept: they haven't allowed it to notify them yet"
    case "declined":
      return "not sent: they declined or turned off its notifications"
  }
}

const notifyLevel = (
  outcome: AppNotificationOutcome,
  delivered: { readonly devices: number; readonly failures: ReadonlyArray<string> } | undefined
): LogLevel =>
  outcome === "held" || (delivered !== undefined && (delivered.devices === 0 || delivered.failures.length > 0))
    ? "warn"
    : "info"

export class AppNotifications extends Context.Service<
  AppNotifications,
  {
    readonly setUp: (
      request: SetUpRequest
    ) => Effect.Effect<{ readonly app: AppSender; readonly card: AccessMessage }, InvalidRequest>
    readonly send: (request: SendRequest) => Effect.Effect<AppNotification, InvalidRequest>
    readonly list: (app: AppId | undefined) => Effect.Effect<AppNotificationsList>
    /** "Allow" on its card. */
    readonly allow: (card: AccessMessage) => Effect.Effect<AccessMessage, InvalidRequest>
    /** "Not now" on its card. */
    readonly decline: (card: AccessMessage, reason: string | undefined) => Effect.Effect<AccessMessage, InvalidRequest>
    readonly update: (
      app: AppId,
      change: { readonly delivery?: AppDelivery | undefined; readonly mutedUntil?: DateTime.Utc | null | undefined }
    ) => Effect.Effect<AppSender, NotFound | InvalidRequest>
    readonly opened: (id: AppNotification["id"]) => Effect.Effect<void, NotFound>
    /** `dream notify withdraw` on one of the apps' notifications: the history says so. */
    readonly withdrawn: (id: AppNotification["id"]) => Effect.Effect<void>
  }
>()("@dream/api/project/AppNotifications") {
  static readonly layer = Layer.effect(
    AppNotifications,
    Effect.gen(function* () {
      const core = yield* Core
      const store = yield* Store
      const notifier = yield* Notifier
      const projectLog = yield* ProjectLog

      const project = core.project.pipe(Effect.orDie)

      const event = <A>(make: (fields: { readonly id: AgentEvent["id"]; readonly at: DateTime.Utc }) => A) =>
        Effect.gen(function* () {
          return make({ id: yield* newEventId(), at: yield* DateTime.now })
        })

      const changed = (
        sender: AppSender,
        change: "allowed" | "declined" | "immediate" | "quiet" | "off" | "muted",
        extra: { readonly reason?: string | undefined; readonly until?: DateTime.Utc | undefined } = {}
      ) =>
        Effect.flatMap(
          event((fields) =>
            AgentEvent.cases.AppNotificationsChanged.make({
              ...fields,
              app: sender.id,
              name: sender.name,
              change,
              ...(extra.reason === undefined ? {} : { reason: extra.reason }),
              ...(extra.until === undefined ? {} : { until: extra.until })
            })
          ),
          core.enqueue
        )

      const resolveUrl = (url: string | undefined) =>
        Effect.gen(function* () {
          if (url === undefined) return undefined
          const resolved = resolveAppUrl((yield* project).publicUrl, url)
          if (Result.isFailure(resolved)) return yield* new InvalidRequest({ message: resolved.failure })
          return resolved.success
        })

      const cardFor = (id: Message["id"]) =>
        Effect.gen(function* () {
          const found = yield* core.message(id)
          return Option.isSome(found) && found.value._tag === "Access" ? Option.some(found.value) : Option.none()
        })

      const setUp = Effect.fn("AppNotifications.setUp")(function* (request: SetUpRequest) {
        if (request.icon?._tag === "Image") {
          return yield* new InvalidRequest({
            message: "A notifying app's tile can be an SF Symbol or an emoji, not an image (yet)."
          })
        }
        const url = yield* resolveUrl(request.url)
        const current = yield* project
        const now = yield* DateTime.now
        const existing = yield* store.appSender(request.app)
        const notifications = AccessRequest.cases.Notifications.make({
          app: request.app,
          name: request.name,
          often: request.often,
          ...(request.icon === undefined ? {} : { icon: request.icon }),
          ...(request.color === undefined ? {} : { color: request.color })
        })
        const label = request.workstream === undefined ? {} : { workstream: request.workstream }
        const described = {
          name: request.name,
          why: request.why,
          often: request.often,
          color: request.color ?? Option.match(existing, { onNone: () => "blue" as const, onSome: (s) => s.color }),
          ...(request.icon === undefined ? {} : { icon: request.icon }),
          ...(url === undefined ? {} : { url })
        }

        // An open or allowed card is updated where it is; a new app, or one they declined, gets a new card.
        if (Option.isSome(existing) && existing.value.state._tag !== "Declined") {
          const sender = existing.value
          const { icon: _i, url: _u, ...rest } = sender
          const next: AppSender = { ...rest, ...described }
          const card = yield* cardFor(sender.messageId)
          if (Option.isNone(card)) return yield* Effect.die(`app ${sender.id} has no card ${sender.messageId}`)
          const updated = AccessMessageSchema.make({
            ...card.value,
            request: notifications,
            why: request.why,
            ...label
          })
          yield* core.changeMessage(updated)
          yield* store.putAppSender(next)
          return { app: next, card: updated }
        }

        const notificationId = yield* newNotificationId()
        const card = AccessMessageSchema.make({
          id: yield* newMessageId(),
          projectId: current.id,
          createdAt: now,
          notificationId,
          request: notifications,
          why: request.why,
          state: AccessState.cases.Open.make({}),
          ...label
        })
        const sender: AppSender = {
          id: request.app,
          ...described,
          messageId: card.id,
          state: { _tag: "Waiting" },
          delivery: Option.match(existing, { onNone: () => "immediate" as const, onSome: (s) => s.delivery }),
          createdAt: Option.match(existing, { onNone: () => now, onSome: (s) => s.createdAt })
        }
        yield* store.putAppSender(sender)
        yield* core.addMessage(card)
        yield* notifier.notify(card, notificationId, "access")
        yield* notifier.asksChanged
        return { app: sender, card }
      })

      const send = Effect.fn("AppNotifications.send")(function* (request: SendRequest) {
        const found = yield* store.appSender(request.app)
        if (Option.isNone(found)) {
          return yield* new InvalidRequest({
            message:
              `No app "${request.app}" is set up to notify them. ` +
              `\`dream notify setup ${request.app} --name … --why … --often …\` sets it up.`
          })
        }
        const sender = found.value
        const url = (yield* resolveUrl(request.url)) ?? sender.url
        const now = yield* DateTime.now
        const nowMs = DateTime.toEpochMillis(now)
        const recent = yield* store.appNotifications(undefined, nowMs - dayMs)
        const decided = decideOutcome({
          sender,
          title: request.title,
          text: request.text,
          quiet: request.quiet,
          nowMs,
          recent
        })
        const notification: AppNotification = {
          id: yield* newNotificationId(),
          app: sender.id,
          ...(request.title === undefined ? {} : { title: request.title }),
          text: request.text,
          ...(url === undefined ? {} : { url }),
          ...(request.key === undefined ? {} : { key: request.key }),
          outcome: decided.outcome,
          ...(decided.held === undefined ? {} : { held: decided.held }),
          sentAt: now
        }
        const kept = reachedPhone(decided.outcome) || decided.outcome === "held" || decided.outcome === "muted"
        if (request.dryRun || !kept) return notification

        if (request.key !== undefined && reachedPhone(decided.outcome)) {
          const older = yield* store.appNotifications(sender.id, 0)
          for (const previous of older) {
            if (previous.key !== request.key || previous.replacedAt !== undefined) continue
            if (!reachedPhone(previous.outcome)) continue
            yield* store.putAppNotification({ ...previous, replacedAt: now })
          }
        }
        yield* store.putAppNotification(notification)
        const delivered = reachedPhone(decided.outcome) ? yield* notifier.alertApp(sender, notification) : undefined
        yield* projectLog.note(
          "notify",
          notifyLevel(decided.outcome, delivered),
          `${sender.name}: "${request.title === undefined ? "" : `${request.title}: `}${request.text}" ${notifyOutcome(decided.outcome, decided.held, delivered)}`,
          { name: sender.id }
        )
        if (decided.held !== undefined) {
          // Once a day an app: the first one held since a day ago.
          const heldBefore = recent.some((n) => n.app === sender.id && n.outcome === "held")
          if (!heldBefore) {
            const limit = decided.held
            yield* core.enqueue(
              yield* event((fields) =>
                AgentEvent.cases.AppNotificationsHeld.make({ ...fields, app: sender.id, name: sender.name, limit })
              )
            )
          }
        }
        yield* store.pruneAppNotifications(
          sender.id,
          nowMs - AppNotificationLimits.historyDays * dayMs,
          AppNotificationLimits.historyPerApp
        )
        return notification
      })

      const list = Effect.fn("AppNotifications.list")(function* (app: AppId | undefined) {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
        const apps = (yield* store.appSenders).filter((s) => app === undefined || s.id === app)
        const notifications = yield* store.appNotifications(app, nowMs - AppNotificationLimits.historyDays * dayMs)
        return { apps, notifications }
      })

      /** The app a card asks for, if the card is still its current one. */
      const senderOf = (card: AccessMessage) =>
        Effect.gen(function* () {
          const sender = yield* store.appSenderFor(card.id)
          if (Option.isNone(sender)) {
            return yield* new InvalidRequest({ message: "This app has asked again; answer its newer card." })
          }
          return sender.value
        })

      const allow = Effect.fn("AppNotifications.allow")(function* (card: AccessMessage) {
        if (card.state._tag === "Allowed") return card
        if (card.state._tag !== "Open" && card.state._tag !== "Declined") {
          return yield* new InvalidRequest({ message: "This request isn't open anymore." })
        }
        const sender = yield* senderOf(card)
        const allowedAt = yield* DateTime.now
        const allowed = AccessMessageSchema.make({ ...card, state: AccessState.cases.Allowed.make({ allowedAt }) })
        const next: AppSender = { ...sender, state: { _tag: "Allowed", allowedAt } }
        yield* store.putAppSender(next)
        yield* core.changeMessage(allowed)
        yield* changed(next, "allowed")
        yield* notifier.withdrawFor(allowed)
        yield* notifier.asksChanged
        return allowed
      })

      const decline = Effect.fn("AppNotifications.decline")(function* (
        card: AccessMessage,
        reason: string | undefined
      ) {
        if (card.state._tag === "Declined") return card
        if (card.state._tag !== "Open") {
          return yield* new InvalidRequest({ message: "This request isn't open anymore." })
        }
        const sender = yield* senderOf(card)
        const declinedAt = yield* DateTime.now
        const declined = AccessMessageSchema.make({
          ...card,
          state: AccessState.cases.Declined.make({ declinedAt, ...(reason === undefined ? {} : { reason }) })
        })
        const next: AppSender = {
          ...sender,
          state: { _tag: "Declined", declinedAt, ...(reason === undefined ? {} : { reason }) }
        }
        yield* store.putAppSender(next)
        yield* core.changeMessage(declined)
        yield* changed(next, "declined", { reason })
        yield* notifier.withdrawFor(declined)
        yield* notifier.asksChanged
        return declined
      })

      const update = Effect.fn("AppNotifications.update")(function* (
        app: AppId,
        change: { readonly delivery?: AppDelivery | undefined; readonly mutedUntil?: DateTime.Utc | null | undefined }
      ) {
        const found = yield* store.appSender(app)
        if (Option.isNone(found)) return yield* new NotFound({ entity: "app", id: app })
        const sender = found.value
        if (sender.state._tag !== "Allowed") {
          return yield* new InvalidRequest({ message: `${sender.name} can't notify you yet; allow it from its card.` })
        }
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
        const { mutedUntil: previousMute, ...rest } = sender
        const wasMuted = previousMute !== undefined && DateTime.toEpochMillis(previousMute) > nowMs
        const mutedUntil =
          change.mutedUntil === undefined ? previousMute : change.mutedUntil === null ? undefined : change.mutedUntil
        const next: AppSender = {
          ...rest,
          delivery: change.delivery ?? sender.delivery,
          ...(mutedUntil === undefined || DateTime.toEpochMillis(mutedUntil) <= nowMs ? {} : { mutedUntil })
        }
        yield* store.putAppSender(next)
        if (next.delivery !== sender.delivery) yield* changed(next, next.delivery)
        if (next.mutedUntil !== undefined && next.mutedUntil !== previousMute) {
          yield* changed(next, "muted", { until: next.mutedUntil })
        } else if (wasMuted && next.mutedUntil === undefined && next.delivery === sender.delivery) {
          yield* changed(next, next.delivery)
        }
        return next
      })

      const opened = Effect.fn("AppNotifications.opened")(function* (id: AppNotification["id"]) {
        const found = yield* store.appNotification(id)
        if (Option.isNone(found)) return yield* new NotFound({ entity: "notification", id })
        if (found.value.openedAt !== undefined) return
        yield* store.putAppNotification({ ...found.value, openedAt: yield* DateTime.now })
      })

      const withdrawn = (id: AppNotification["id"]) =>
        Effect.gen(function* () {
          const found = yield* store.appNotification(id)
          if (Option.isNone(found) || found.value.withdrawnAt !== undefined) return
          yield* store.putAppNotification({ ...found.value, withdrawnAt: yield* DateTime.now })
        })

      return AppNotifications.of({ setUp, send, list, allow, decline, update, opened, withdrawn })
    })
  )
}
