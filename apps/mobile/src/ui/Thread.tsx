/**
 * A message's thread, over its project's Chat: the message on top (a question or access request there can still be
 * answered), the replies under it along a line, and a composer that writes into the thread. It opens from the line
 * a thread folds into, from Reply in a message's menu or the expanded view, from a swipe, and from a notification
 * about a reply. What they send goes in the message's workstream too (the API sees to that).
 */
import type { Message, ProjectId } from "@dream/domain"
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef, useState } from "react"
import { Keyboard, type ScrollViewInstance, Text, type TextInputInstance, View } from "react-native"
import { KeyboardChatScrollView, KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller"
import Animated, { FadeOut, SlideInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { dayLabel, sameDay, timeLabel } from "../data/format.ts"
import { receiptOf } from "../data/presence.ts"
import type { ProjectState } from "../data/projectState.ts"
import { threadOf } from "../data/threads.ts"
import { sendMessageFn, threadAtom } from "../state/atoms.ts"
import type { OpenThread } from "../state/ui.ts"
import { useAction } from "./actions.ts"
import { useStagedAttachments } from "./Attachments.tsx"
import { ChatActivity, Holdable, MessageBody } from "./Chat.tsx"
import { ChatComposer } from "./Composer.tsx"
import { useNow, useRequestId } from "./hooks.ts"
import { IconButton } from "./kit.tsx"
import { color, gutter } from "./theme.ts"

export function ThreadView(props: {
  readonly state: ProjectState
  readonly open: OpenThread
  /** The workstream's title when the message has one the card shows. */
  readonly label: string | undefined
  readonly onClose: () => void
}) {
  const live = props.state.messages.some((m) => m.id === props.open.messageId)
  return live ? (
    <ThreadLayer {...props} fetched={undefined} />
  ) : (
    <FetchedThread {...props} projectId={props.state.project.id} />
  )
}

/** A thread whose first message is older than the Chat loaded: fetched once, then kept live. */
function FetchedThread(props: Parameters<typeof ThreadView>[0] & { readonly projectId: ProjectId }) {
  const result = useAtomValue(threadAtom(`${props.projectId}/${props.open.messageId}`))
  return <ThreadLayer {...props} fetched={Option.getOrUndefined(AsyncResult.value(result))} />
}

function ThreadLayer(
  props: Parameters<typeof ThreadView>[0] & {
    readonly fetched: { readonly root: Message; readonly replies: ReadonlyArray<Message> } | undefined
  }
) {
  const { state, open } = props
  const insets = useSafeAreaInsets()
  const now = useNow()
  const send = useAction(sendMessageFn)
  const attachments = useStagedAttachments()
  const requestId = useRequestId()
  const input = useRef<TextInputInstance>(null)
  const scroll = useRef<ScrollViewInstance>(null)
  const { root, replies } = threadOf(state.messages, open.messageId, props.fetched)
  const [highlight, setHighlight] = useState(open.highlight)
  const typing = useKeyboardState((k) => k.isVisible)

  // Reply (from a menu, or the expanded view) gives the composer the keyboard, again each time it's asked; opening it
  // otherwise (its folded line, a notification) puts away the keyboard Chat's composer had.
  useEffect(() => {
    if (!open.compose) {
      Keyboard.dismiss()
      return
    }
    const timer = setTimeout(() => input.current?.focus(), 380)
    return () => clearTimeout(timer)
  }, [open.compose, open.at])
  useEffect(() => {
    if (highlight === undefined) return
    const timer = setTimeout(() => setHighlight(undefined), 2400)
    return () => clearTimeout(timer)
  }, [highlight])

  const all = root === undefined ? replies : [root, ...replies]
  const receipt = receiptOf(all, state.activity)
  const time = (m: Message) =>
    sameDay(m.createdAt, now) ? timeLabel(m.createdAt) : `${dayLabel(m.createdAt, now)}, ${timeLabel(m.createdAt)}`
  const composerBottom = Math.max(insets.bottom, 12) + 2
  const keyboardOffset = composerBottom - 10
  const header = insets.top + 4 + 48 + 8

  return (
    <Animated.View
      entering={SlideInDown.duration(320)}
      exiting={FadeOut.duration(160)}
      style={{ position: "absolute", inset: 0, backgroundColor: color.bg, zIndex: 20 }}
      accessibilityViewIsModal
    >
      <KeyboardChatScrollView
        ref={scroll}
        offset={keyboardOffset}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: header + 10, paddingBottom: 24, paddingHorizontal: gutter, gap: 14 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {root ? (
          <Holdable message={root}>
            <MessageBody message={root} time={time(root)} />
          </Holdable>
        ) : (
          <Text style={{ alignSelf: "center", fontSize: 13, color: color.t3 }}>Loading the thread…</Text>
        )}
        {replies.length > 0 ? (
          <View style={{ marginLeft: 8, paddingLeft: 14, borderLeftWidth: 1.5, borderColor: color.line2, gap: 14 }}>
            {replies.map((reply) => (
              <Reply
                key={reply.id}
                message={reply}
                time={time(reply)}
                receipt={receipt?.messageId === reply.id ? { seen: receipt.seen } : undefined}
                highlighted={reply.id === highlight}
              />
            ))}
          </View>
        ) : null}
        <ChatActivity state={state} />
      </KeyboardChatScrollView>

      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          paddingTop: insets.top + 4,
          paddingHorizontal: gutter,
          backgroundColor: color.bg
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 48, marginLeft: -2 }}>
          <IconButton icon="chevDown" size={38} label="Close the thread" onPress={props.onClose} />
          <View style={{ flex: 1, alignItems: "center" }}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: color.t1, letterSpacing: -0.2 }}>Thread</Text>
            <Text numberOfLines={1} style={{ fontSize: 13, color: color.t3, marginTop: 1 }}>
              {props.label ?? state.project.title}
            </Text>
          </View>
          {typing ? (
            <IconButton icon="keyboardDown" size={38} label="Hide the keyboard" onPress={() => Keyboard.dismiss()} />
          ) : (
            <View style={{ width: 38 }} />
          )}
        </View>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: -18,
            height: 18,
            experimental_backgroundImage: `linear-gradient(${color.bg} 12%, rgba(10,10,12,0))`
          }}
        />
      </View>

      <KeyboardStickyView
        offset={{ opened: keyboardOffset }}
        style={{ paddingHorizontal: 16, paddingBottom: composerBottom, paddingTop: 10 }}
      >
        <ChatComposer
          busy={send.busy}
          inputRef={input}
          placeholder="Reply"
          attachments={attachments}
          onSend={(text, sent, attached) =>
            send.run(
              {
                projectId: state.project.id,
                text,
                requestId: requestId.for(attached.length === 0 ? text : `${text}\n${attached.join(",")}`),
                replyTo: open.messageId,
                ...(attached.length === 0 ? {} : { attachments: attached })
              },
              {
                onSuccess: () => {
                  requestId.done()
                  sent()
                }
              }
            )
          }
        />
      </KeyboardStickyView>
    </Animated.View>
  )
}

/** A reply in the thread, ringed for a moment when the thread opened at it (from a notification). */
function Reply(props: {
  readonly message: Message
  readonly time: string
  readonly receipt: { readonly seen: boolean } | undefined
  readonly highlighted: boolean
}) {
  return (
    <Holdable message={props.message}>
      <View
        style={
          props.highlighted
            ? { borderRadius: 18, margin: -6, padding: 6, backgroundColor: "rgba(255,255,255,0.06)" }
            : undefined
        }
      >
        <MessageBody message={props.message} time={props.time} receipt={props.receipt} />
      </View>
    </Holdable>
  )
}
