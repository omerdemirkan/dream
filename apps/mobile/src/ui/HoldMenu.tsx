/**
 * Holding a message lifts it over a dimmed screen, where it was, with its menu: Reply (its thread), Copy, and its
 * card's own actions (Open, Don't connect). Any message: theirs, the agent's, a question or an access request, in
 * Chat or in a thread. Drawn here rather than with iOS's context menu so a card lifts as it is and the menu can
 * hold the card's own actions; it needs nothing native beyond gesture handling and haptics.
 */
import type { Message } from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as Clipboard from "expo-clipboard"
import * as Haptics from "expo-haptics"
import { Option } from "effect"
import { Pressable, Text, useWindowDimensions, View } from "react-native"
import Animated, { FadeIn, FadeOut, ZoomIn } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { copyText } from "../data/threads.ts"
import { declineAtom, focusAtom, type Held, heldAtom, threadOpenAtom } from "../state/ui.ts"
import { useToast } from "./actions.ts"
import { MessageBody } from "./Chat.tsx"
import { type Glyph, Icon } from "./kit.tsx"
import { color } from "./theme.ts"

interface Action {
  readonly title: string
  readonly icon: Glyph
  readonly run: () => void
  /** Starts a group of its own (a card's actions, under Reply and Copy). */
  readonly apart?: boolean
}

const itemHeight = 46
const menuWidth = 232

export function HoldMenu(props: { readonly projectId: Message["projectId"] }) {
  const held = Option.getOrUndefined(useAtomValue(heldAtom))
  if (!held || held.message.projectId !== props.projectId) return null
  return <HoldLayer key={held.message.id} held={held} />
}

function HoldLayer(props: { readonly held: Held }) {
  const { message, rect } = props.held
  const { width: W, height: H } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const setHeld = useAtomSet(heldAtom)
  const setThread = useAtomSet(threadOpenAtom)
  const setFocus = useAtomSet(focusAtom)
  const setDecline = useAtomSet(declineAtom)
  const toast = useToast()
  const close = () => setHeld(Option.none())
  const then = (run: () => void) => () => {
    close()
    run()
  }

  const actions: Array<Action> = [
    {
      title: "Reply",
      icon: "reply",
      run: then(() =>
        setThread(
          Option.some({
            projectId: message.projectId,
            messageId: message.replyTo ?? message.id,
            compose: true,
            at: Date.now()
          })
        )
      )
    },
    {
      title: "Copy",
      icon: "copy",
      run: then(() => {
        void Clipboard.setStringAsync(copyText(message))
        void Haptics.selectionAsync()
        toast("Copied", { done: true })
      })
    }
  ]
  if (message._tag !== "Text") {
    actions.push({
      title: "Open",
      icon: "expand",
      apart: true,
      run: then(() =>
        setFocus(Option.some({ projectId: message.projectId, messageId: message.id, origin: rect, message }))
      )
    })
  }
  if (
    message._tag === "Access" &&
    message.state._tag === "Open" &&
    message.when === undefined &&
    message.request._tag !== "Notifications"
  ) {
    actions.push({ title: "Don’t connect", icon: "close", run: then(() => setDecline(Option.some(message))) })
  }

  // The message stays where it was when the menu fits under it; otherwise it moves up, and one taller than the
  // screen shows its top.
  const menuHeight = actions.length * itemHeight + (actions.some((a) => a.apart) ? 8 : 0)
  const top = insets.top + 12
  const bottom = H - Math.max(insets.bottom, 12) - 12
  const shown = Math.min(rect.height, bottom - top - menuHeight - 10)
  const liftedTop = Math.max(top, Math.min(rect.y, bottom - menuHeight - 10 - shown))
  const menuTop = liftedTop + shown + 10
  const mine = message._tag === "Text" && message.from === "user"
  const menuLeft = mine ? Math.max(12, rect.x + rect.width - menuWidth) : Math.min(rect.x, W - menuWidth - 12)

  return (
    <View style={{ position: "absolute", inset: 0, zIndex: 50 }} accessibilityViewIsModal>
      <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(140)} style={{ flex: 1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close the menu"
          onPress={close}
          style={{ flex: 1, backgroundColor: "rgba(6,6,8,0.78)" }}
        />
      </Animated.View>
      <Animated.View
        entering={ZoomIn.duration(200)}
        pointerEvents="none"
        style={{
          position: "absolute",
          left: rect.x,
          top: liftedTop,
          width: rect.width,
          height: shown,
          overflow: "hidden",
          borderRadius: message._tag === "Text" ? 0 : 24
        }}
      >
        <MessageBody message={message} time={undefined} />
      </Animated.View>
      <Animated.View
        entering={FadeIn.duration(180).delay(60)}
        style={{
          position: "absolute",
          left: menuLeft,
          top: menuTop,
          width: menuWidth,
          borderRadius: 14,
          overflow: "hidden",
          backgroundColor: "rgba(44,44,49,0.98)",
          boxShadow: "0 16px 40px rgba(0,0,0,0.6)"
        }}
      >
        {actions.map((action, i) => (
          <Pressable
            key={action.title}
            accessibilityRole="button"
            onPress={action.run}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              height: itemHeight + (action.apart ? 8 : 0),
              paddingHorizontal: 16,
              backgroundColor: pressed ? "rgba(255,255,255,0.08)" : "transparent",
              borderTopWidth: i === 0 ? 0 : action.apart ? 8 : 0.5,
              borderTopColor: action.apart ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.1)"
            })}
          >
            <Text style={{ fontSize: 16.5, color: color.t1 }}>{action.title}</Text>
            <Icon name={action.icon} size={17} color={color.t1} />
          </Pressable>
        ))}
      </Animated.View>
    </View>
  )
}
