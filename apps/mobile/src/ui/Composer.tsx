/**
 * The composers: type, or tap the mic to dictate into the field, then send.
 *
 * - `ChatComposer`: "Message Dream" at the bottom of Chat (`.compose.quiet`).
 * - `ElseComposer`: "Something else…" in the expanded question (`.else`).
 */
import { useState } from "react"
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

export function ChatComposer(props: {
  readonly onSend: (text: string) => void
  readonly sample?: string
  readonly busy?: boolean
}) {
  const [text, setText] = useState("")
  const dictation = useDictation((heard) => setText((current) => join(current, heard)), props.sample)
  const has = text.trim().length > 0
  const send = () => {
    if (!has) return
    props.onSend(text.trim())
    setText("")
  }
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
  readonly onSend: (text: string) => void
  readonly sample?: string
  readonly large?: boolean
}) {
  const [text, setText] = useState("")
  const dictation = useDictation((heard) => setText((current) => join(current, heard)), props.sample)
  const has = text.trim().length > 0
  const height = props.large ? 58 : 48
  const button = props.large ? 42 : 36
  const send = () => {
    if (!has) return
    props.onSend(text.trim())
    setText("")
  }
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
        <IconButton icon="up" tone="need" size={button} label="Send" onPress={send} />
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
