/**
 * New idea: a plain composer. Type, or tap the mic to dictate into the field,
 * then send. Lands in the new project's Chat with the idea as its first message.
 */
import { useLocalSearchParams, useRouter } from "expo-router"
import { useEffect, useRef, useState } from "react"
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  type TextInputInstance,
  View
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useDictation } from "../platform/dictation.ts"
import { createProjectFn } from "../state/atoms.ts"
import { useAction } from "../ui/actions.ts"
import { Bars, Icon, IconButton } from "../ui/kit.tsx"
import { color, gutter } from "../ui/theme.ts"

export default function NewIdea() {
  const router = useRouter()
  const params = useLocalSearchParams<{ dictate?: string; text?: string }>()
  const insets = useSafeAreaInsets()
  const [text, setText] = useState(params.text ?? "")
  const input = useRef<TextInputInstance>(null)
  const create = useAction(createProjectFn)
  const dictation = useDictation(
    (heard) => setText((current) => (current.trim() ? `${current.trimEnd()} ${heard}` : heard)),
    "Scale any recipe up or down, and keep the ingredient math honest."
  )
  const has = text.trim().length > 0

  useEffect(() => {
    if (params.dictate) {
      const id = setTimeout(dictation.toggle, 450)
      return () => clearTimeout(id)
    }
    const id = setTimeout(() => input.current?.focus(), 350)
    return () => clearTimeout(id)
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = () => {
    if (!has || create.busy) return
    dictation.stop()
    create.run(text.trim(), {
      onSuccess: (project) => {
        router.dismissAll()
        router.push({ pathname: "/project/[id]", params: { id: project.id, tab: "chat" } })
      },
      onFailure: (_, error) => {
        if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "NoModelConnection") {
          router.push("/connect")
        }
      }
    })
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 4, paddingHorizontal: gutter, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 44 }}>
          <IconButton icon="close" label="Close" onPress={() => router.back()} />
          <Text style={{ fontSize: 15, fontWeight: "600", color: color.t2 }}>New idea</Text>
          <View style={{ width: 40 }} />
        </View>
        <TextInput
          ref={input}
          value={text}
          onChangeText={setText}
          multiline
          placeholder="What do you want to exist?"
          placeholderTextColor={color.t3}
          keyboardAppearance="dark"
          style={{
            marginTop: 26,
            fontSize: 32,
            lineHeight: 37,
            letterSpacing: -1.1,
            fontWeight: "600",
            color: color.t1,
            minHeight: 44,
            padding: 0
          }}
          accessibilityLabel="Your idea"
        />
        <Text style={{ fontSize: 14.5, lineHeight: 21, color: color.t3, marginTop: 8, maxWidth: 300 }}>
          A sentence is enough. I’ll look into it first, then write to you with questions — that can take a few minutes.
        </Text>
      </ScrollView>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          height: 56,
          marginHorizontal: 16,
          marginBottom: Math.max(insets.bottom, 12) + 2
        }}
      >
        {dictation.available ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dictation.listening ? "Stop dictating" : "Dictate"}
            onPress={dictation.toggle}
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: dictation.listening ? color.need : color.s2,
              borderWidth: 1,
              borderColor: dictation.listening ? color.need : color.line2,
              alignItems: "center",
              justifyContent: "center"
            }}
          >
            <Icon name="mic" size={22} color={dictation.listening ? color.needInk : color.t1} />
          </Pressable>
        ) : null}
        {dictation.listening ? (
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Bars />
            <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, fontSize: 15, color: color.t2 }}>
              {dictation.heard || "Listening…"}
            </Text>
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!has || create.busy}
          onPress={send}
          style={{
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: has ? color.t1 : color.s2,
            borderWidth: 1,
            borderColor: has ? color.t1 : color.line2,
            alignItems: "center",
            justifyContent: "center",
            opacity: create.busy ? 0.6 : 1
          }}
        >
          <Icon name="up" size={22} color={has ? color.black : color.t3} weight="semibold" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}
