/**
 * Push notifications, sent directly from the Worker to APNs.
 *
 * The Worker builds `aps` itself (alert, sound, `thread-id` = project id,
 * `category` = `NotificationCategory`). Next to `aps`, under `PushDataKey`, it
 * puts a `PushData` value the app decodes to route the tap or clean up.
 */
import { Schema } from "effect"
import { MessageId, NotificationId, ProjectId } from "./Ids.ts"

/**
 * Top-level key for Dream's data in the APNs payload.
 * Mobile: confirm where expo-notifications surfaces custom keys for direct
 * APNs pushes; if it only reads "body", change it here so both sides follow.
 */
export const PushDataKey = "dream"

export const NotificationCategory = Schema.Literals(["message", "question", "access"])
export type NotificationCategory = typeof NotificationCategory.Type

export const PushData = Schema.TaggedUnion({
  /** A visible notification about a message. Tapping it opens that message (expanded for questions and access). */
  OpenMessage: { projectId: ProjectId, messageId: MessageId, notificationId: NotificationId },
  /**
   * A silent push (`content-available: 1`) listing delivered notifications to
   * remove. Best effort: the app also asks `FilterStaleNotifications` when opened.
   */
  Withdraw: { notificationIds: Schema.NonEmptyArray(NotificationId) }
})
export type PushData = typeof PushData.Type
