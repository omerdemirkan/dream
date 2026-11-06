/**
 * The composers: type, or tap the mic to dictate into the field, then send.
 *
 * - `ChatComposer`: "Message Dream" at the bottom of Chat (`.compose.quiet`).
 * - `ElseComposer`: "Something else…" in the expanded question (`.else`).
 * - `ReasonField`: why they decline an access request, in the decline sheet (no send button; the sheet sends).
 */
import { type Ref, useEffect, useRef, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, type TextInputInstance, View } from "react-native"
import { useDictation } from "../platform/dictation.ts"
import { Bars, Icon, IconButton } from "./kit.tsx"
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
 * The field's placeholder, drawn as Text behind an empty field rather than by UIKit, whose placeholder can sit
 * below the caret, with stale tracking, once the field has been edited, cleared or reused for another field.
 */
export function FieldPlaceholder(props: { readonly text: string; readonly color: string; readonly fontSize: number }) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { justifyContent: "center" }]}>
      <Text numberOfLines={1} accessible={false} style={{ fontSize: props.fontSize, color: props.color }}>
        {props.text}
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

/** The workstream they're writing to, on the composer: tap it to write to the whole project again. */
function ScopeTag(props: { readonly title: string; readonly onClear: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Writing to ${props.title}`}
      accessibilityHint="Writes to the whole project instead"
      onPress={props.onClear}
      hitSlop={6}
      style={({ pressed }) => ({
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        height: 30,
        maxWidth: "100%",
        paddingLeft: 11,
        paddingRight: 9,
        borderRadius: 15,
        backgroundColor: pressed ? color.line2 : color.s3
      })}
    >
      <Icon name="reply" size={13} color={color.t2} weight="semibold" />
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13.5, fontWeight: "600", color: color.t1 }}>
        {props.title}
      </Text>
      <Icon name="close" size={11} color={color.t3} weight="semibold" />
    </Pressable>
  )
}

export function ChatComposer(props: {
  readonly onSend: Send
  readonly sample?: string
  readonly busy?: boolean
  readonly draft?: string | undefined
  /** Writing to one workstream: its tag sits above the field, and clearing it writes to the whole project. */
  readonly scope?: { readonly title: string; readonly onClear: () => void } | undefined
  readonly inputRef?: Ref<TextInputInstance>
}) {
  const [text, setText] = useState("")
  useDraft(props.draft, setText)
  const dictation = useDictation((heard) => setText((current) => join(current, heard)), props.sample)
  const { has, send } = useSend(text, setText, props.onSend, props.busy === true)
  const scope = props.scope
  return (
    <View
      style={[
        {
          borderRadius: 28,
          backgroundColor: color.s1,
          borderWidth: 1,
          borderColor: dictation.listening ? color.needLine : scope ? color.line2 : color.line,
          boxShadow: "0 10px 34px rgba(0,0,0,0.55)"
        },
        scope ? { paddingTop: 9, paddingLeft: 9, borderRadius: 26 } : null
      ]}
    >
      {scope ? <ScopeTag title={scope.title} onClear={scope.onClear} /> : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          height: scope ? 50 : 54,
          paddingLeft: scope ? 11 : 20,
          paddingRight: 8
        }}
      >
        <View style={{ flex: 1, height: "100%" }}>
          {text ? null : (
            <FieldPlaceholder
              text={scope ? `Message about ${scope.title}` : "Message Dream"}
              color={color.t2}
              fontSize={16}
            />
          )}
          <TextInput
            ref={props.inputRef}
            value={text}
            onChangeText={setText}
            style={{ flex: 1, color: color.t1, fontSize: 16 }}
            returnKeyType="send"
            onSubmitEditing={send}
            submitBehavior="submit"
            keyboardAppearance="dark"
            accessibilityLabel="Message Dream"
          />
        </View>
        {dictation.listening ? <Listening heard={dictation.heard} inset={20} radius={28} /> : null}
        {has && !dictation.listening ? (
          <IconButton
            icon="up"
            tone="white"
            label={props.busy === true ? "Sending" : "Send"}
            onPress={send}
            disabled={props.busy === true}
            busy={props.busy === true}
          />
        ) : dictation.available ? (
          <IconButton
            icon="mic"
            tone={dictation.listening ? "need" : "quiet"}
            label={dictation.listening ? "Stop dictating" : "Dictate"}
            onPress={dictation.toggle}
          />
        ) : null}
      </View>
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
      <View style={{ flex: 1, height: "100%" }}>
        {text ? null : <FieldPlaceholder text="Something else…" color={color.t3} fontSize={props.large ? 17 : 16} />}
        <TextInput
          value={text}
          onChangeText={setText}
          style={{ flex: 1, color: color.t1, fontSize: props.large ? 17 : 16 }}
          returnKeyType="send"
          onSubmitEditing={send}
          submitBehavior="submit"
          keyboardAppearance="dark"
          accessibilityLabel="Something else"
        />
      </View>
      {dictation.listening ? <Listening heard={dictation.heard} inset={16} radius={props.large ? 18 : 16} /> : null}
      {has && !dictation.listening ? (
        <IconButton
          icon="up"
          tone="need"
          size={button}
          label={props.busy === true ? "Sending" : "Send"}
          onPress={send}
          disabled={props.busy === true}
          busy={props.busy === true}
        />
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

export function ReasonField(props: {
  readonly value: string
  readonly onChange: (text: string) => void
  readonly onFocus?: () => void
  readonly sample?: string
}) {
  const value = useRef(props.value)
  value.current = props.value
  const dictation = useDictation((heard) => props.onChange(join(value.current, heard)), props.sample)
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 50,
        paddingLeft: 16,
        paddingRight: 6,
        borderRadius: 16,
        backgroundColor: color.s2,
        borderWidth: 1,
        borderColor: dictation.listening ? color.needLine : props.value.trim() ? color.line2 : color.line
      }}
    >
      <View style={{ flex: 1, height: "100%" }}>
        {props.value ? null : <FieldPlaceholder text="Something else…" color={color.t3} fontSize={16} />}
        <TextInput
          value={props.value}
          onChangeText={props.onChange}
          onFocus={props.onFocus}
          style={{ flex: 1, color: color.t1, fontSize: 16 }}
          maxLength={500}
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
          keyboardAppearance="dark"
          accessibilityLabel="Another reason"
        />
      </View>
      {dictation.listening ? <Listening heard={dictation.heard} inset={16} radius={16} /> : null}
      {dictation.available ? (
        <IconButton
          icon="mic"
          size={38}
          tone={dictation.listening ? "need" : "plain"}
          label={dictation.listening ? "Stop dictating" : "Dictate"}
          onPress={dictation.toggle}
          style={dictation.listening ? null : { backgroundColor: color.s3 }}
        />
      ) : null}
    </View>
  )
}
