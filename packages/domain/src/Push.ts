/**
 * Push notifications, sent directly from the Worker to APNs.
 *
 * The Worker builds `aps` itself (alert, sound, `thread-id` = project id,
 * `category` = `NotificationCategory`). Next to `aps`, under `PushDataKey`, it
 * puts a `PushData` value the app decodes to route the tap or clean up.
 */
import { Schema } from "effect"
import { AppId, MessageId, NotificationId, ProjectId } from "./Ids.ts"

/**
 * Top-level key for Dream's data in the APNs payload.
 * Mobile: confirm where expo-notifications surfaces custom keys for direct
 * APNs pushes; if it only reads "body", change it here so both sides follow.
 */
export const PushDataKey = "dream"

/** `app`: from one of the project's apps (`dream notify`), with Mute and Turn off actions. Added in November 2026. */
export const NotificationCategory = Schema.Literals(["message", "question", "access", "app"])
export type NotificationCategory = typeof NotificationCategory.Type

export const PushData = Schema.TaggedUnion({
  /** A visible notification about a message. Tapping it opens that message (expanded for questions and access). */
  OpenMessage: { projectId: ProjectId, messageId: MessageId, notificationId: NotificationId },
  /**
   * A notification from one of the project's apps. Tapping it opens `url` (on the project's published URL) full
   * screen inside Dream, or without one the project's Notifications sheet. Added in November 2026: older apps don't
   * decode it, so a tap just opens Dream.
   */
  OpenApp: {
    projectId: ProjectId,
    app: AppId,
    notificationId: NotificationId,
    url: Schema.optionalKey(Schema.String)
  },
  /**
   * A limit they set on the project was reached and it's paused. Tapping it opens the project's usage sheet, where
   * they can raise or clear the limit. Added in November 2026: older apps don't decode it, so a tap just opens Dream.
   */
  OpenUsage: { projectId: ProjectId, notificationId: NotificationId },
  /**
   * A silent push (`content-available: 1`) listing delivered notifications to
   * remove. Best effort: the app also asks `FilterStaleNotifications` when opened.
   */
  Withdraw: { notificationIds: Schema.NonEmptyArray(NotificationId) }
})
export type PushData = typeof PushData.Type
