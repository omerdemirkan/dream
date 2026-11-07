/**
 * App notifications: what the apps an agent builds tell them on their own, under their own name, without the agent
 * ("Fare watch: Lisbon dropped to $412"), usually from a scheduled `--run` job while the agent sleeps.
 *
 * An app gets a name before it gets a voice. `dream notify setup <app>` makes an `AppSender` and puts a
 * `Notifications` access card in Chat; nothing the app sends reaches their phone until they allow it there.
 * `dream notify --app <app> "…"` sends one, and the ProjectDO decides what happens to it (`AppNotificationOutcome`):
 * their choices for that app, Dream's limits, and repeats. Each app keeps a short history, which the phone shows in
 * the project's Notifications sheet next to that app's controls. Chat never shows them.
 */
import { Schema } from "effect"
import { AppId, MessageId, NotificationId } from "./Ids.ts"
import { LinkColor, LinkIcon } from "./Links.ts"
import { DeclineReason } from "./Message.ts"

/** What Dream holds each app and project to, and how long it keeps what they sent. */
export const AppNotificationLimits = {
  /** Pushed (sent or quiet) by one app in the last hour, and in the last 24 hours. */
  perAppHour: 6,
  perAppDay: 24,
  /** Pushed by all of a project's apps in the last 24 hours. */
  perProjectDay: 48,
  /** The same title and text from the same app within this many hours is a repeat, and dropped. */
  repeatHours: 6,
  /** The history keeps 30 days, and at most 100 per app. */
  historyDays: 30,
  historyPerApp: 100
} as const

/** The name a notification is titled with ("Fare watch"): one line, up to 30 characters. */
export const AppName = Schema.String.check(
  Schema.makeFilter((text: string) => text.trim() === text || "has spaces at either end"),
  Schema.makeFilter((text: string) => !/[\n\r\t]/.test(text) || "must be one line"),
  Schema.isMinLength(1),
  Schema.isMaxLength(30)
)

/** The body: plain text, up to 500 characters. The lock screen shows about four lines. */
export const AppNotificationText = Schema.NonEmptyString.check(Schema.isMaxLength(500))
/** The bold headline above the text, one line. */
export const AppNotificationTitle = Schema.NonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.makeFilter((text: string) => !/[\n\r]/.test(text) || "must be one line")
)
/** What a notification is about; a newer one with the same key replaces the older. */
export const AppNotificationKey = Schema.NonEmptyString.check(Schema.isMaxLength(64))

/** How their app's notifications reach them: with a sound, quietly (Notification Center only), or not at all. */
export const AppDelivery = Schema.Literals(["immediate", "quiet", "off"])
export type AppDelivery = typeof AppDelivery.Type

export const AppSenderState = Schema.TaggedUnion({
  /** Its card is open in Chat. */
  Waiting: {},
  Allowed: { allowedAt: Schema.DateTimeUtc },
  Declined: { declinedAt: Schema.DateTimeUtc, reason: Schema.optionalKey(DeclineReason) }
})
export type AppSenderState = typeof AppSenderState.Type

/** An app that can notify them, as the agent set it up and as they've chosen to hear from it. */
export const AppSender = Schema.Struct({
  id: AppId,
  name: AppName,
  /** Its tile, drawn like an app link's: a symbol or emoji on `color`, or the name's first letter. */
  icon: Schema.optionalKey(LinkIcon),
  color: LinkColor,
  /** Where a tap goes when a notification names no page: a page of the project's published URL. */
  url: Schema.optionalKey(Schema.String),
  /** What it will tell them, and how often, as its card said. */
  why: Schema.NonEmptyString,
  often: Schema.NonEmptyString,
  /** Its `Notifications` card in Chat. */
  messageId: MessageId,
  state: AppSenderState,
  /** Theirs. */
  delivery: AppDelivery,
  /** Theirs: nothing reaches them before this. */
  mutedUntil: Schema.optionalKey(Schema.DateTimeUtc),
  createdAt: Schema.DateTimeUtc
})
export type AppSender = typeof AppSender.Type

/**
 * What happened to a notification. `sent` and `quiet` reached their phone (`quiet`: in Notification Center, with no
 * sound); `held` went over a limit (`AppNotification.held`); `muted` met their Off or Mute; `duplicate` repeated one
 * sent within `repeatHours`; `waiting` and `declined` came from an app they haven't allowed. Only the first four are
 * kept in the history. None of them is a failure of the app.
 */
export const AppNotificationOutcome = Schema.Literals([
  "sent",
  "quiet",
  "held",
  "muted",
  "duplicate",
  "waiting",
  "declined"
])
export type AppNotificationOutcome = typeof AppNotificationOutcome.Type

/** Which limit held a notification back: the app's hourly or daily one, or the project's daily one. */
export const AppNotificationLimit = Schema.Literals(["hour", "day", "project"])
export type AppNotificationLimit = typeof AppNotificationLimit.Type

export const AppNotification = Schema.Struct({
  id: NotificationId,
  app: AppId,
  title: Schema.optionalKey(Schema.String),
  text: Schema.String,
  /** Where a tap goes: a full URL on the project's published URL. */
  url: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
  outcome: AppNotificationOutcome,
  held: Schema.optionalKey(AppNotificationLimit),
  sentAt: Schema.DateTimeUtc,
  /** A newer one with the same key took its place. */
  replacedAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** They tapped it, or its row in the history. */
  openedAt: Schema.optionalKey(Schema.DateTimeUtc),
  withdrawnAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type AppNotification = typeof AppNotification.Type

/** A project's apps that notify, and what they sent, newest first. */
export const AppNotifications = Schema.Struct({
  apps: Schema.Array(AppSender),
  notifications: Schema.Array(AppNotification)
})
export type AppNotifications = typeof AppNotifications.Type

/** Whether a notification reached their phone. */
export const reachedPhone = (outcome: AppNotificationOutcome): boolean => outcome === "sent" || outcome === "quiet"
