/**
 * The composers: type, or tap the mic to dictate into the field, then send.
 *
 * - `ChatComposer`: "Message Dream" at the bottom of Chat (`.compose.quiet`).
 * - `ElseComposer`: "Something else…" in the expanded question (`.else`).
 */
import { useEffect, useState } from "react"
import { StyleSheet, Text, TextInput, View } from "react-native"
import { useDictation } from "../platform/dictation.ts"
import { Bars, IconButton } from "./kit.tsx"
import { color } from "./theme.ts"

const join = (current: string, heard: string) => (current.trim() ? `${current.trimEnd()} ${heard}` : heard)

function Listening(props: { readonly heard: string; readonly inset: number; readonly radius: number }) {
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingLeft: props.inset,
          paddingRight: 58,
          backgroundColor: color.s1,
          borderRadius: props.radius
        }
      ]}
    >
      <Bars />
      <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, color: color.t2, fontSize: 15 }}>
        {props.heard || "Listening…"}
      </Text>
    </View>
  )
}

/**
 * Sending hands the text to `onSend` with a `sent` callback. The field keeps
 * the text until the write goes through, so a failed or timed-out send leaves
 * it there to try again.
 */
type Send = (text: string, sent: () => void) => void

/** Sends what's in the field unless a send is already in flight; clears it on `sent` unless they've edited it since. */
const useSend = (text: string, setText: (update: (current: string) => string) => void, onSend: Send, busy: boolean) => {
  const has = text.trim().length > 0
  const send = () => {
    if (!has || busy) return
    const sending = text.trim()
    onSend(sending, () => setText((current) => (current.trim() === sending ? "" : current)))
  }
  return { has, send }
}

/** Puts a kept draft (a reply that didn't send from a notification) into the field, unless they've typed. */
const useDraft = (draft: string | undefined, setText: (update: (current: string) => string) => void) =>
  useEffect(() => {
    if (draft) setText((current) => (current.trim() ? current : draft))
  }, [draft, setText])

export function ChatComposer(props: {
  readonly onSend: Send
  readonly sample?: string
  readonly busy?: boolean
  readonly draft?: string | undefined
}) {
  const [text, setText] = useState("")
  useDraft(props.draft, setText)
  const dictation = useDictation((heard) => setText((current) => join(current, heard)), props.sample)
  const { has, send } = useSend(text, setText, props.onSend, props.busy === true)
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        height: 56,
        paddingLeft: 20,
        paddingRight: 8,
        borderRadius: 28,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: dictation.listening ? color.needLine : color.line,
        boxShadow: "0 10px 34px rgba(0,0,0,0.55)"
      }}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Message Dream"
        placeholderTextColor={color.t2}
        style={{ flex: 1, color: color.t1, fontSize: 16, height: "100%" }}
        returnKeyType="send"
        onSubmitEditing={send}
        submitBehavior="submit"
        keyboardAppearance="dark"
        accessibilityLabel="Message Dream"
      />
      {dictation.listening ? <Listening heard={dictation.heard} inset={20} radius={28} /> : null}
      {has && !dictation.listening ? (
        <IconButton icon="up" tone="white" label="Send" onPress={send} disabled={props.busy === true} />
      ) : dictation.available ? (
        <IconButton
          icon="mic"
          tone={dictation.listening ? "need" : "quiet"}
          label={dictation.listening ? "Stop dictating" : "Dictate"}
          onPress={dictation.toggle}
        />
      ) : null}
    </View>
  )
}

export function ElseComposer(props: {
  readonly onSend: Send
  readonly sample?: string
  readonly large?: boolean
  readonly busy?: boolean
  readonly draft?: string | undefined
}) {
  const [text, setText] = useState("")
  useDraft(props.draft, setText)
  const dictation = useDictation((heard) => setText((current) => join(current, heard)), props.sample)
  const { has, send } = useSend(text, setText, props.onSend, props.busy === true)
  const height = props.large ? 58 : 48
  const button = props.large ? 42 : 36
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height,
        paddingLeft: 16,
        paddingRight: 6,
        borderRadius: props.large ? 18 : 16,
        borderWidth: 1,
        borderStyle: dictation.listening ? "solid" : "dashed",
        borderColor: dictation.listening ? color.needLine : color.line2
      }}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Something else…"
        placeholderTextColor={color.t3}
        style={{ flex: 1, color: color.t1, fontSize: props.large ? 17 : 16, height: "100%" }}
        returnKeyType="send"
        onSubmitEditing={send}
        submitBehavior="submit"
        keyboardAppearance="dark"
        accessibilityLabel="Something else"
      />
      {dictation.listening ? <Listening heard={dictation.heard} inset={16} radius={props.large ? 18 : 16} /> : null}
      {has && !dictation.listening ? (
        <IconButton icon="up" tone="need" size={button} label="Send" onPress={send} disabled={props.busy === true} />
      ) : dictation.available ? (
        <IconButton
          icon="mic"
          size={button}
          tone={dictation.listening ? "need" : "plain"}
          label={dictation.listening ? "Stop dictating" : "Dictate"}
          onPress={dictation.toggle}
          style={dictation.listening ? null : { backgroundColor: color.s2 }}
        />
      ) : null}
    </View>
  )
}
