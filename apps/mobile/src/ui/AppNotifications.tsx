/**
 * Notifications from a project's apps, on the phone: the card in Chat that asks to let one notify them, the
 * project's Notifications sheet (each app's controls, and what it sent in the last 30 days), and opening an app's
 * page from one of its notifications, full screen inside Dream like an app link.
 */
import {
  type AccessMessage,
  type AppDelivery,
  type AppNotifications as AppNotificationsList,
  type AppSender,
  type NotificationId,
  type ProjectId
} from "@dream/domain"
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { DateTime, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import * as WebBrowser from "expo-web-browser"
import { forwardRef, useCallback, useEffect } from "react"
import {
  ActivityIndicator,
  type HostInstance,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native"
import Animated, { Easing, SlideInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { appLine, type HistoryRow, historyRows, isMuted, startOfTomorrow } from "../data/appNotifications.ts"
import {
  allowAppNotificationsFn,
  appNotificationsAtom,
  openedAppNotificationFn,
  updateAppNotificationsFn
} from "../state/atoms.ts"
import { appNotificationsSheetAtom } from "../state/ui.ts"
import { useAction, useToast } from "./actions.ts"
import { useDecline } from "./Decline.tsx"
import { Button, IconButton } from "./kit.tsx"
import { LinkTile } from "./LinkTile.tsx"
import { Card, CardHead, ResolvedRow } from "./Messages.tsx"
import { color, gutter, tracking } from "./theme.ts"

type NotificationsRequest = Extract<AccessMessage["request"], { readonly _tag: "Notifications" }>

/** Whether a message is an app's card asking to notify them. */
export const isNotificationsCard = (
  message: AccessMessage
): message is AccessMessage & { readonly request: NotificationsRequest } => message.request._tag === "Notifications"

/** The app's tile, drawn like an app link's. */
export function AppTile(props: {
  readonly app: Pick<AppSender, "name" | "icon" | "color"> | Pick<NotificationsRequest, "name" | "icon" | "color">
  readonly size: number
}) {
  const { app } = props
  return (
    <LinkTile
      look={{ title: app.name, color: app.color ?? "blue", ...(app.icon === undefined ? {} : { icon: app.icon }) }}
      size={props.size}
    />
  )
}

/** Opens a page of the app full screen inside Dream, and tells Dream they opened that notification. */
export function useOpenAppPage() {
  const opened = useAtomSet(openedAppNotificationFn)
  return useCallback(
    (input: { readonly projectId: ProjectId; readonly notificationId?: NotificationId; readonly url: string }) => {
      if (input.notificationId !== undefined)
        opened({ projectId: input.projectId, notificationId: input.notificationId })
      void WebBrowser.openBrowserAsync(input.url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
        controlsColor: color.t1,
        toolbarColor: color.bg,
        dismissButtonStyle: "done"
      })
    },
    [opened]
  )
}

/** Opens the project's Notifications sheet. */
export function useOpenAppNotifications() {
  const set = useAtomSet(appNotificationsSheetAtom)
  return useCallback((projectId: ProjectId) => set(Option.some(projectId)), [set])
}

// ---------------------------------------------------------------------------
// The card in Chat
// ---------------------------------------------------------------------------

/** "Allow" and "Not now", for an open card or, in the sheet, one they declined. */
export function AllowButtons(props: {
  readonly message: AccessMessage
  readonly declinable: boolean
  readonly size?: "sm" | "lg"
}) {
  const allow = useAction(allowAppNotificationsFn)
  const decline = useDecline(props.message)
  const toast = useToast()
  const height = props.size === "lg" ? 50 : 42
  return (
    <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
      {props.declinable ? (
        <Button title="Not now" variant="ghost" onPress={decline.open} style={{ flex: 1, height }} />
      ) : null}
      <Button
        title="Allow"
        variant="need"
        busy={allow.busy}
        onPress={() =>
          allow.run(
            { projectId: props.message.projectId, messageId: props.message.id },
            { onFailure: (message) => toast(message) }
          )
        }
        style={{ flex: 1, height }}
      />
    </View>
  )
}

export const NotificationsCard = forwardRef<
  HostInstance,
  { readonly message: AccessMessage & { readonly request: NotificationsRequest }; readonly onOpen: () => void }
>(function NotificationsCard(props, ref) {
  const m = props.message
  const app = m.request
  if (m.state._tag === "Allowed") {
    return (
      <Card ref={ref} tone="done" onOpen={props.onOpen}>
        <ResolvedRow
          label="Notifications · allowed"
          title={`${app.name} can notify you`}
          strong
          check
          detail="Quiet it or turn it off from the bell above."
        />
      </Card>
    )
  }
  if (m.state._tag !== "Open") {
    const reason = m.state._tag === "Declined" ? m.state.reason : undefined
    return (
      <Card ref={ref} tone="done" onOpen={props.onOpen}>
        <ResolvedRow
          label="Notifications · not allowed"
          title={app.name}
          strong
          check={false}
          detail={
            reason ? (
              <>
                {"You said: "}
                <Text style={{ color: color.t1 }}>{`“${reason}”`}</Text>
                {" · Tap to allow it."}
              </>
            ) : (
              "You said not now. Tap to allow it."
            )
          }
        />
      </Card>
    )
  }
  return (
    <Card ref={ref} tone="need" onOpen={props.onOpen}>
      <CardHead label="Notifications" />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 9, marginHorizontal: 2 }}>
        <AppTile app={app} size={28} />
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: color.t3 }}>
          <Text style={{ fontWeight: "600", color: color.t2 }}>{app.name}</Text> wants to notify you
        </Text>
      </View>
      <Text
        style={{
          fontSize: 19,
          lineHeight: 23,
          fontWeight: "600",
          letterSpacing: -0.48,
          color: color.t1,
          marginTop: 10,
          marginHorizontal: 2
        }}
      >
        {m.why}
      </Text>
      <Text style={{ fontSize: 14, lineHeight: 20, color: color.t2, marginTop: 6, marginHorizontal: 2 }}>
        {`${app.often.replace(/[.\s]+$/, "")}. They come from ${app.name} itself, and you can quiet it any time.`}
      </Text>
      <AllowButtons message={m} declinable />
    </Card>
  )
})

// ---------------------------------------------------------------------------
// The project's Notifications sheet
// ---------------------------------------------------------------------------

export function AppNotificationsSheet(props: { readonly projectId: ProjectId; readonly title: string }) {
  const insets = useSafeAreaInsets()
  const shown = Option.getOrUndefined(useAtomValue(appNotificationsSheetAtom))
  const set = useAtomSet(appNotificationsSheetAtom)
  const open = shown === props.projectId
  const close = () => set(Option.none())
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View style={{ flex: 1 }}>
        <Pressable
          accessibilityLabel="Close"
          onPress={close}
          style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.58)" }]}
        />
        {open ? (
          <Animated.View
            entering={SlideInDown.duration(340).easing(Easing.bezier(0.2, 0.8, 0.2, 1))}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              top: insets.top + 50,
              backgroundColor: color.s1,
              borderTopLeftRadius: 30,
              borderTopRightRadius: 30,
              borderCurve: "continuous",
              borderWidth: 1,
              borderBottomWidth: 0,
              borderColor: color.line2,
              overflow: "hidden"
            }}
          >
            <View
              style={{
                alignSelf: "center",
                width: 36,
                height: 5,
                borderRadius: 3,
                backgroundColor: "rgba(255,255,255,0.22)",
                marginTop: 10,
                marginBottom: 14
              }}
            />
            <SheetContent
              projectId={props.projectId}
              title={props.title}
              onClose={close}
              bottom={Math.max(insets.bottom, 16) + 12}
            />
          </Animated.View>
        ) : null}
      </View>
    </Modal>
  )
}

function SheetContent(props: {
  readonly projectId: ProjectId
  readonly title: string
  readonly onClose: () => void
  readonly bottom: number
}) {
  const result = useAtomValue(appNotificationsAtom(props.projectId))
  const refresh = useAtomRefresh(appNotificationsAtom(props.projectId))
  useEffect(() => refresh(), [refresh])
  const list = Option.getOrUndefined(AsyncResult.value(result))
  return (
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: props.bottom }}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 20, fontWeight: "700", letterSpacing: tracking(-0.035, 20), color: color.t1 }}>
            Notifications
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 13.5, color: color.t3, marginTop: 1 }}>
            From what {props.title} made
          </Text>
        </View>
        <IconButton icon="close" size={32} tone="quiet" label="Close" onPress={props.onClose} />
      </View>
      {list ? (
        list.apps.length === 0 ? (
          <Text style={{ fontSize: 14.5, lineHeight: 20, color: color.t2, marginTop: 24 }}>
            Nothing here notifies you yet. When something {props.title} made wants to, it asks you in Chat first.
          </Text>
        ) : (
          list.apps.map((app) => <AppSection key={app.id} projectId={props.projectId} app={app} list={list} />)
        )
      ) : AsyncResult.isFailure(result) ? (
        <Text style={{ fontSize: 14.5, color: color.t2, marginTop: 24 }}>
          Notifications aren’t available right now.
        </Text>
      ) : (
        <ActivityIndicator color={color.t3} style={{ marginTop: 40 }} />
      )}
    </ScrollView>
  )
}

const deliveries: ReadonlyArray<{ readonly value: AppDelivery; readonly label: string }> = [
  { value: "immediate", label: "Immediately" },
  { value: "quiet", label: "Quietly" },
  { value: "off", label: "Off" }
]

function AppSection(props: {
  readonly projectId: ProjectId
  readonly app: AppSender
  readonly list: AppNotificationsList
}) {
  const { app, projectId } = props
  const now = DateTime.nowUnsafe()
  const update = useAction(updateAppNotificationsFn)
  const toast = useToast()
  const openPage = useOpenAppPage()
  const rows = historyRows(app, props.list.notifications, now)
  const muted = isMuted(app, now)
  const change = (input: { readonly delivery?: AppDelivery; readonly mutedUntil?: DateTime.Utc | null }) =>
    update.run({ projectId, app: app.id, ...input }, { onFailure: (message) => toast(message) })
  return (
    <View style={{ marginTop: 22 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <AppTile app={app} size={44} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 16.5, fontWeight: "600", color: color.t1 }}>
            {app.name}
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 13.5, color: color.t3, marginTop: 1 }}>
            {appLine(app, props.list.notifications, now)}
          </Text>
        </View>
      </View>
      {app.state._tag === "Allowed" ? (
        <>
          <Segments
            options={deliveries}
            selected={app.delivery}
            onPick={(delivery) => change({ delivery })}
            disabled={update.busy}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => change({ mutedUntil: muted ? null : startOfTomorrow(now) })}
            style={({ pressed }) => ({
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 10,
              paddingVertical: 12,
              paddingHorizontal: 14,
              borderRadius: 14,
              backgroundColor: pressed ? color.s3 : color.s2
            })}
          >
            <Text style={{ fontSize: 15, color: color.t1 }}>{muted ? "Unmute" : "Mute for today"}</Text>
            {muted ? <Text style={{ fontSize: 13.5, color: color.t3 }}>{appLine(app, [], now)}</Text> : null}
          </Pressable>
        </>
      ) : (
        <WaitingApp projectId={projectId} app={app} />
      )}
      {rows.length > 0 ? (
        <>
          <Text
            style={{
              fontSize: 12,
              fontWeight: "600",
              letterSpacing: 1,
              textTransform: "uppercase",
              color: color.t3,
              marginTop: 20,
              marginBottom: 2
            }}
          >
            Recent
          </Text>
          {rows.map((row) => (
            <History
              key={row.id}
              row={row}
              onOpen={row.url ? () => openPage({ projectId, notificationId: row.id, url: row.url! }) : undefined}
            />
          ))}
        </>
      ) : null}
    </View>
  )
}

/** An app they haven't allowed: what it asked, and Allow. */
function WaitingApp(props: { readonly projectId: ProjectId; readonly app: AppSender }) {
  const { app } = props
  // Allow goes through the app's card, which the sheet stands in for.
  const card: AccessMessage = {
    _tag: "Access",
    id: app.messageId,
    projectId: props.projectId,
    createdAt: app.createdAt,
    request: {
      _tag: "Notifications",
      app: app.id,
      name: app.name,
      often: app.often,
      ...(app.icon === undefined ? {} : { icon: app.icon }),
      color: app.color
    },
    why: app.why,
    state: app.state._tag === "Declined" ? { _tag: "Declined", declinedAt: app.state.declinedAt } : { _tag: "Open" }
  }
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={{ fontSize: 15, lineHeight: 21, color: color.t1 }}>{app.why}</Text>
      <Text style={{ fontSize: 13.5, lineHeight: 19, color: color.t2, marginTop: 3 }}>{app.often}</Text>
      <AllowButtons message={card} declinable={app.state._tag === "Waiting"} />
    </View>
  )
}

function Segments<T extends string>(props: {
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>
  readonly selected: T
  readonly onPick: (value: T) => void
  readonly disabled?: boolean
}) {
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: "row", marginTop: 14, padding: 2, borderRadius: 12, backgroundColor: color.s2 }}
    >
      {props.options.map((option) => {
        const on = option.value === props.selected
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            disabled={props.disabled === true}
            onPress={() => (on ? undefined : props.onPick(option.value))}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: 8,
              borderRadius: 10,
              backgroundColor: on ? color.s3 : "transparent"
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: on ? color.t1 : color.t2 }}>{option.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function History(props: { readonly row: HistoryRow; readonly onOpen: (() => void) | undefined }) {
  const { row } = props
  return (
    <Pressable
      accessibilityRole={props.onOpen ? "link" : undefined}
      disabled={props.onOpen === undefined}
      onPress={props.onOpen}
      style={({ pressed }) => ({
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: color.line,
        opacity: row.dim ? 0.55 : pressed ? 0.7 : 1
      })}
    >
      <View style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, fontWeight: "600", color: color.t1 }}>
          {row.title}
        </Text>
        <Text style={{ fontSize: 12.5, color: color.t3 }}>{row.time}</Text>
      </View>
      {row.tag || row.text ? (
        <Text numberOfLines={2} style={{ fontSize: 14, lineHeight: 19, color: color.t2, marginTop: 2 }}>
          {row.tag ? <Text style={{ color: color.t3 }}>{`${row.tag} · `}</Text> : null}
          {row.text ?? ""}
        </Text>
      ) : null}
    </Pressable>
  )
}
