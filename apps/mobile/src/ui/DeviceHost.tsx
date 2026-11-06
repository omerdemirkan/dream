/**
 * Everything the app does for this device while someone is signed in:
 * registering push and Live Activity tokens, routing notification taps and
 * lock-screen replies, removing withdrawn notifications, and refreshing when
 * the app comes back to the foreground.
 */
import { NotificationId, ProjectId, RequestId } from "@dream/domain"
import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Effect, Option, Schema } from "effect"
import * as Notifications from "expo-notifications"
import { useRouter } from "expo-router"
import { useEffect, useRef } from "react"
import { AppState } from "react-native"
import { DreamNative } from "../../modules/dream-native/index.ts"
import { showsWhileOpen } from "../data/notificationPresentation.ts"
import { randomUuid } from "../data/Session.ts"
import * as Push from "../platform/push.ts"
import { viewingProject } from "../platform/viewing.ts"
import {
  cleanUpNotificationsFn,
  fixturePushesAtom,
  flushAnswersFn,
  reconnectProjectsFn,
  refreshHomeFn,
  registerDeviceFn,
  registerLiveActivityFn,
  replyFn
} from "../state/atoms.ts"
import { askPushAtom, landingAtom } from "../state/ui.ts"
import { useAction, useToast } from "./actions.ts"
import { useOpenMessage } from "./hooks.ts"

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const show = showsWhileOpen(Push.pushDataOf(notification), viewingProject())
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false }
  }
})

export function DeviceHost() {
  const router = useRouter()
  const open = useOpenMessage()
  const setLanding = useAtomSet(landingAtom)
  const registerDevice = useAtomSet(registerDeviceFn)
  const registerActivity = useAtomSet(registerLiveActivityFn)
  const cleanUp = useAtomSet(cleanUpNotificationsFn)
  const refreshHome = useAtomSet(refreshHomeFn)
  const reconnect = useAtomSet(reconnectProjectsFn)
  const flush = useAtomSet(flushAnswersFn)
  // Replies typed into a notification: retried, and if they still fail, kept as a draft where they belong.
  const reply = useAction(replyFn).run
  const toast = useToast()
  const tokens = useRef<{ apnsToken?: string; pushToStartToken?: string }>({})
  useAtomMount(fixturePushesAtom)

  // Tokens: APNs for alerts and silent pushes, ActivityKit for Live Activities.
  useEffect(() => {
    const register = () => registerDevice({ ...tokens.current })
    register()
    void Effect.runPromise(
      Effect.all([Push.registerCategories, Push.registerWithdrawTask], { discard: true }).pipe(Effect.ignore)
    )
    const tokenListener = Notifications.addPushTokenListener((token) => {
      if (typeof token.data === "string" && token.data !== tokens.current.apnsToken) {
        tokens.current = { ...tokens.current, apnsToken: token.data }
        register()
      }
    })
    const live = DreamNative
    const subscriptions = live
      ? [
          live.addListener("onPushToStartToken", ({ token }) => {
            if (token === tokens.current.pushToStartToken) return
            tokens.current = { ...tokens.current, pushToStartToken: token }
            register()
          }),
          live.addListener("onActivityToken", ({ activityId, projectId, token }) => {
            const id = Schema.decodeUnknownOption(ProjectId)(projectId)
            if (Option.isSome(id)) registerActivity({ projectId: id.value, activityId, pushToken: token })
          })
        ]
      : []
    live?.observeActivities()
    return () => {
      tokenListener.remove()
      for (const s of subscriptions) s.remove()
    }
  }, [registerDevice, registerActivity])

  // The APNs token: silently if already allowed; asking only when a moment calls for it.
  const ask = useAtomValue(askPushAtom)
  useEffect(() => {
    void Effect.runPromise(Push.apnsToken(ask > 0).pipe(Effect.option)).then((token) => {
      const value = Option.getOrUndefined(Option.flatten(token))
      if (value && value !== tokens.current.apnsToken) {
        tokens.current = { ...tokens.current, apnsToken: value }
        registerDevice({ ...tokens.current })
      }
    })
  }, [ask, registerDevice])

  // Taps and lock-screen replies.
  const lastResponse = Notifications.useLastNotificationResponse()
  const handled = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!lastResponse) return
    const key = `${lastResponse.notification.request.identifier}:${lastResponse.actionIdentifier}`
    if (handled.current === key) return
    handled.current = key
    const data = Push.pushDataOf(lastResponse.notification)
    if (Option.isNone(data) || data.value._tag !== "OpenMessage") return
    const { projectId, messageId } = data.value
    const category = lastResponse.notification.request.content.categoryIdentifier
    const text = lastResponse.userText?.trim()
    if (lastResponse.actionIdentifier === Push.ReplyAction && text) {
      const question = category === Push.Category.question
      const target = question
        ? ({ _tag: "Answer", projectId, messageId } as const)
        : ({ _tag: "Chat", projectId } as const)
      reply(
        { ...target, text, requestId: RequestId.make(randomUuid()) },
        {
          onFailure: () => {
            const where = question ? "It’s waiting in the question." : "It’s waiting in Chat."
            toast(`${question ? "Your answer" : "Your reply"} didn’t send. ${where}`)
            // Typed on the lock screen, so the app may not be open to show the toast: say so where they'll see it.
            if (AppState.currentState !== "active") {
              void Effect.runPromise(
                Push.presentLocal({
                  title: question ? "Your answer didn’t send" : "Your reply didn’t send",
                  body: `“${text}” Tap to send it.`,
                  category: question ? "question" : "message",
                  data: data.value
                }).pipe(Effect.ignore)
              )
            }
          }
        }
      )
      return
    }
    if (category === Push.Category.question || category === Push.Category.access) {
      open({ projectId, messageId })
    } else {
      setLanding(Option.some({ projectId, messageId, highlight: true, at: Date.now() }))
      router.push({ pathname: "/project/[id]", params: { id: projectId, tab: "chat" } })
    }
  }, [lastResponse, reply, toast, open, router, setLanding])

  // Pushes that arrive while the app is open: withdrawals, and news for Home's rows.
  useEffect(() => {
    const received = Notifications.addNotificationReceivedListener((notification) => {
      const data = Push.pushDataOf(notification)
      if (Option.isNone(data)) return
      if (data.value._tag === "Withdraw") {
        const ids = data.value.notificationIds.flatMap((id) =>
          Option.toArray(Schema.decodeUnknownOption(NotificationId)(id))
        )
        void Effect.runPromise(Push.removeDelivered(ids).pipe(Effect.ignore))
      } else refreshHome()
    })
    return () => received.remove()
  }, [refreshHome])

  // Foreground: catch up. Background: send answers still held for Undo.
  useEffect(() => {
    cleanUp()
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        cleanUp()
        refreshHome()
        reconnect()
      } else if (state === "background") {
        flush()
      }
    })
    return () => subscription.remove()
  }, [cleanUp, refreshHome, reconnect, flush])

  return null
}
