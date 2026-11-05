/**
 * Push notifications, sent by the Worker straight to APNs.
 *
 * - The app registers the raw APNs device token (not an Expo push token).
 * - Dream's data sits next to `aps` under `PushDataKey`. expo-notifications
 *   exposes the full APNs payload as `request.trigger.payload` for remote
 *   pushes (its `content.data` is only the Expo service's "body" key), and as
 *   `data` minus `aps` in the background task. Local notifications (fixtures
 *   mode) carry it in `content.data`.
 * - A silent `Withdraw` push removes delivered notifications by id, and the
 *   app asks `FilterStaleNotifications` whenever it opens, since APNs can't
 *   delete anything itself.
 */
import { PushData, PushDataKey } from "@dream/domain"
import { Data, Effect, Option, Schema } from "effect"
import * as Notifications from "expo-notifications"
import * as TaskManager from "expo-task-manager"

export class PushError extends Data.TaggedError("PushError")<{ readonly step: string; readonly cause: unknown }> {}

const PushDataJson = Schema.toCodecJson(PushData)
export const decodePushData = Schema.decodeUnknownOption(PushDataJson)
export const encodePushData = Schema.encodeSync(PushDataJson)

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

/** Dream's data in a delivered notification, remote or local. */
export const pushDataOf = (notification: Notifications.Notification): Option.Option<PushData> => {
  const trigger = notification.request.trigger
  const fromPayload = field(field(trigger, "payload"), PushDataKey)
  const fromContent = field(notification.request.content.data, PushDataKey)
  return decodePushData(fromPayload ?? fromContent)
}

export const Category = { message: "message", question: "question", access: "access" } as const
export const ReplyAction = "reply"

/** Categories registered with iOS: questions and messages can be answered from the lock screen. */
export const registerCategories = Effect.tryPromise({
  try: () =>
    Promise.all([
      Notifications.setNotificationCategoryAsync(Category.question, [
        {
          identifier: ReplyAction,
          buttonTitle: "Answer…",
          textInput: { submitButtonTitle: "Send", placeholder: "Something else…" }
        }
      ]),
      Notifications.setNotificationCategoryAsync(Category.message, [
        {
          identifier: ReplyAction,
          buttonTitle: "Reply…",
          textInput: { submitButtonTitle: "Send", placeholder: "Message Dream" }
        }
      ]),
      Notifications.setNotificationCategoryAsync(Category.access, [])
    ]),
  catch: (cause) => new PushError({ step: "categories", cause })
}).pipe(Effect.asVoid)

/**
 * The hex APNs device token, if iOS gives one. Asks for permission only when
 * `ask` is set: Dream asks at a moment that explains itself (after the first
 * idea or answer), not at launch.
 */
export const apnsToken = (ask: boolean): Effect.Effect<Option.Option<string>, PushError> =>
  Effect.gen(function* () {
    const current = yield* Effect.tryPromise({
      try: () => Notifications.getPermissionsAsync(),
      catch: (cause) => new PushError({ step: "permissions", cause })
    })
    const granted = current.granted
      ? true
      : ask && current.canAskAgain
        ? (yield* Effect.tryPromise({
            try: () =>
              Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } }),
            catch: (cause) => new PushError({ step: "permissions", cause })
          })).granted
        : false
    if (!granted) return Option.none()
    const token = yield* Effect.tryPromise({
      try: () => Notifications.getDevicePushTokenAsync(),
      catch: (cause) => new PushError({ step: "device token", cause })
    })
    return token.type === "ios" && typeof token.data === "string" ? Option.some(token.data) : Option.none()
  })

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Removes delivered notifications whose ids (the `apns-id`s) are listed. */
export const removeDelivered = (ids: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      const presented = await Notifications.getPresentedNotificationsAsync()
      await Promise.all(
        presented
          .filter((n) => ids.some((id) => sameId(id, n.request.identifier)))
          .map((n) => Notifications.dismissNotificationAsync(n.request.identifier))
      )
    },
    catch: (cause) => new PushError({ step: "remove delivered", cause })
  })

/** Ids of everything Dream has on the lock screen right now. */
export const deliveredIds = Effect.tryPromise({
  try: () => Notifications.getPresentedNotificationsAsync(),
  catch: (cause) => new PushError({ step: "presented", cause })
}).pipe(Effect.map((presented) => presented.map((n) => n.request.identifier)))

/** Shows a notification on this phone with the same data shape a real push carries (fixtures mode). */
export const presentLocal = (push: {
  readonly title: string
  readonly body: string
  readonly category: keyof typeof Category
  readonly data: PushData
}) =>
  Effect.tryPromise({
    try: () =>
      Notifications.scheduleNotificationAsync({
        ...(push.data._tag === "OpenMessage" ? { identifier: push.data.notificationId } : {}),
        content: {
          title: push.title,
          body: push.body,
          categoryIdentifier: push.category,
          sound: "default",
          data: { [PushDataKey]: encodePushData(push.data) }
        },
        trigger: null
      }),
    catch: (cause) => new PushError({ step: "local notification", cause })
  })

// ---------------------------------------------------------------------------
// Silent pushes while the app isn't running
// ---------------------------------------------------------------------------

export const WithdrawTask = "dream-withdraw-notifications"

TaskManager.defineTask<Notifications.NotificationTaskPayload>(WithdrawTask, async ({ data }) => {
  // A tap arrives as a NotificationResponse; a silent push as { data, aps } with Dream's key in `data`.
  const raw = "actionIdentifier" in data ? undefined : data.data
  const decoded = decodePushData(field(raw, PushDataKey))
  if (Option.isSome(decoded) && decoded.value._tag === "Withdraw") {
    await Effect.runPromise(removeDelivered(decoded.value.notificationIds).pipe(Effect.ignore))
    return Notifications.BackgroundNotificationTaskResult.NewData
  }
  return Notifications.BackgroundNotificationTaskResult.NoData
})

export const registerWithdrawTask = Effect.tryPromise({
  try: () => Notifications.registerTaskAsync(WithdrawTask),
  catch: (cause) => new PushError({ step: "background task", cause })
})
