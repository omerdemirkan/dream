/**
 * New idea: the page (Deck v3, option A). The whole page below the nav is one
 * field: tap anywhere to write, put the cursor anywhere, select, edit. The mic
 * dictates in at the cursor (or over the selection), showing settled words and
 * the ones still being recognized in place; a pause doesn't stop it. Tapping
 * the text while dictating stops and keeps what was heard, with the cursor
 * after it. Return is a new line; only Send sends, and it lands in the new
 * project's Chat with the idea as its first message.
 *
 * While the page is blank, a row of starters sits above the buttons. Tapping one
 * fills the page with its draft, ready to send as it is, with the cursor after
 * it to keep writing. `/new?starter=<idea id>` opens with a draft.
 *
 * The paperclip beside the mic attaches photos and files, which wait above the
 * buttons and go with the idea as part of its first message.
 */
import { useAtomSet } from "@effect/atom-react"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useEffect, useRef, useState } from "react"
import {
  Pressable,
  ScrollView,
  StyleSheet,
  type ScrollViewInstance,
  Text,
  TextInput,
  type TextInputInstance,
  type TextStyle,
  View
} from "react-native"
import { KeyboardAvoidingView } from "react-native-keyboard-controller"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { caretAt, ideaToSend, insertAt, placeTake, type Selection, wordCountLabel } from "../data/draft.ts"
import { draftOf, type Idea, ideas } from "../data/ideas.ts"
import { longIdea } from "../fake/fixtures.ts"
import { useDictation } from "../platform/dictation.ts"
import { createProjectFn } from "../state/atoms.ts"
import { askPushAtom } from "../state/ui.ts"
import { useAction, useToast } from "../ui/actions.ts"
import { useRequestId } from "../ui/hooks.ts"
import { Bars, Icon, IconButton } from "../ui/kit.tsx"
import { samplesFor } from "../ui/attachmentSamples.ts"
import { AttachmentTray, useStagedAttachments } from "../ui/Attachments.tsx"
import { Starters } from "../ui/Starters.tsx"
import { color, gutter, tracking } from "../ui/theme.ts"

/** `.dump`: body size, so a long brain dump reads like a note. */
const lineHeight = 28
const page: TextStyle = {
  fontSize: 19,
  lineHeight,
  letterSpacing: tracking(-0.012, 19),
  fontWeight: "400",
  color: color.t1
}
const pad = { paddingHorizontal: gutter, paddingTop: 18, paddingBottom: 28 } as const
/** The field draws each line 3 pt lower than Text does with the same line height (measured in the Simulator). */
const livePad = { ...pad, paddingTop: pad.paddingTop + 3 } as const
const placeholderPosition: TextStyle = { position: "absolute", top: 0, left: 0, right: 0, color: color.t3 }

function useSeconds(running: boolean) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!running) return
    setSeconds(0)
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [running])
  return seconds
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`

export default function NewIdea() {
  const router = useRouter()
  const params = useLocalSearchParams<{
    dictate?: string
    text?: string
    sample?: string
    starter?: string
    attach?: string
  }>()
  const insets = useSafeAreaInsets()
  const barBottom = Math.max(insets.bottom, 12) + 2
  const [text, setText] = useState(() => {
    const starter = ideas.find((i) => i.id === params.starter)
    return starter ? draftOf(starter) : (params.text ?? (params.sample === "long" ? longIdea : ""))
  })
  const textRef = useRef(text)
  textRef.current = text
  const input = useRef<TextInputInstance>(null)
  /** Where the cursor is (or was, when the field last had focus). */
  const selection = useRef<Selection>(caretAt(text.length))
  /** Puts the cursor here once the field has the text it's for (after a starter). */
  const caretTo = useRef<Selection | null>(null)
  /** Where the current take goes: the selection when the mic was tapped. */
  const [anchor, setAnchor] = useState<Selection>(selection.current)
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  /** After a take ends: where the cursor goes, and whether to put it there (not when the take was sent). */
  const caretAfter = useRef<number | null>(null)
  const refocus = useRef(true)
  /** How far the field is scrolled, so the live text opens at the same place. */
  const scrolled = useRef(0)
  const create = useAction(createProjectFn)
  const attachments = useStagedAttachments(samplesFor(params.attach))
  const requestId = useRequestId()
  const toast = useToast()
  const askPush = useAtomSet(askPushAtom)
  const dictation = useDictation((heard) => {
    const placed = insertAt(textRef.current, anchorRef.current, heard)
    caretAfter.current = placed.caret
    setText(placed.text)
  }, "Scale any recipe up or down, and keep the ingredient math honest. Eggs don’t come in halves, and a pinch stays a pinch.")
  const listening = dictation.listening
  const seconds = useSeconds(listening)
  const idea = ideaToSend(text, anchor, listening ? dictation.transcript : undefined)
  const has = idea.length > 0
  const busy = create.busy || attachments.uploading

  useEffect(() => {
    if (params.dictate) {
      const id = setTimeout(startDictating, 450)
      return () => clearTimeout(id)
    }
    const id = setTimeout(() => {
      input.current?.focus()
      input.current?.setSelection(selection.current.start, selection.current.end)
    }, 350)
    return () => clearTimeout(id)
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When a take ends, the field comes back with the cursor right after what was said.
  const wasListening = useRef(false)
  useEffect(() => {
    if (wasListening.current && !listening && refocus.current) {
      // A take that heard nothing leaves the selection as it was.
      const at = caretAfter.current === null ? anchorRef.current : caretAt(caretAfter.current)
      selection.current = at
      input.current?.focus()
      input.current?.setSelection(at.start, at.end)
    }
    caretAfter.current = null
    refocus.current = true
    wasListening.current = listening
  }, [listening])

  // A starter filled the page: the cursor goes after it, keyboard up, to keep writing.
  useEffect(() => {
    const at = caretTo.current
    if (!at) return
    caretTo.current = null
    const id = requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelection(at.start, at.end)
    })
    return () => cancelAnimationFrame(id)
  }, [text])

  function startFrom(idea: Idea) {
    const draft = draftOf(idea)
    textRef.current = draft
    // Dictation started before the field reports the new cursor still lands at the end.
    selection.current = caretAt(draft.length)
    caretTo.current = selection.current
    setText(draft)
  }

  function startDictating() {
    setAnchor(selection.current)
    // The field gives way to the live text, which also ends the keyboard's own dictation, so the two never share the mic.
    input.current?.blur()
    dictation.toggle()
  }

  const send = () => {
    if (!idea || busy) return
    if (listening) {
      // Everything heard so far goes in where it was landing, so a failed send leaves the whole idea on the page.
      refocus.current = false
      setText(placeTake(text, anchor, dictation.transcript).text)
      dictation.cancel()
    }
    const attached = attachments.ids
    create.run(
      {
        idea,
        requestId: requestId.for(attached.length === 0 ? idea : `${idea}\n${attached.join(",")}`),
        ...(attached.length === 0 ? {} : { attachments: attached })
      },
      {
        onSuccess: (project) => {
          requestId.done()
          // Its first question can take minutes: now is when notifications make sense.
          askPush((n) => n + 1)
          // The page gives way to the new project's Chat, with Home behind it.
          router.replace({ pathname: "/project/[id]", params: { id: project.id, tab: "chat" } })
        },
        // The idea stays on the page, so they can send it again.
        onFailure: (message, error) => {
          if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "NoModelConnection") {
            router.push("/connect")
          } else toast(message)
        }
      }
    )
  }

  return (
    // The bar rides the keyboard frame by frame, from above the home indicator to 10 pt above the keyboard.
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={-(barBottom - 10)}
      style={{ flex: 1, backgroundColor: color.bg }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          height: 44,
          marginTop: insets.top + 4,
          paddingHorizontal: gutter
        }}
      >
        <IconButton icon="close" label="Close" onPress={() => router.back()} />
        <Text style={{ fontSize: 15, fontWeight: "600", color: color.t2 }}>New idea</Text>
        <View style={{ width: 40 }} />
      </View>
      {/* The field stays put under the live text, so it comes back scrolled where it was. */}
      <View style={{ flex: 1 }}>
        {/* The placeholder as Text where the field draws its first line (UIKit's drifts and loses the tracking). */}
        {text ? null : (
          <Text pointerEvents="none" accessible={false} style={[page, livePad, placeholderPosition]}>
            {"What do you want to exist?\nThink out loud. Messy is fine."}
          </Text>
        )}
        <TextInput
          ref={input}
          value={text}
          onChangeText={setText}
          onScroll={(e) => {
            scrolled.current = e.nativeEvent.contentOffset.y
          }}
          onSelectionChange={(e) => {
            selection.current = e.nativeEvent.selection
          }}
          multiline
          submitBehavior="newline"
          keyboardAppearance="dark"
          selectionColor={color.need}
          textAlignVertical="top"
          style={[page, pad, { flex: 1 }]}
          accessibilityLabel="Your idea"
          accessibilityElementsHidden={listening}
        />
        {listening ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: color.bg }]}>
            <LiveText
              {...placeTake(text, anchor, dictation.transcript)}
              startY={scrolled.current}
              onPress={dictation.stop}
            />
          </View>
        ) : null}
      </View>
      {/* Just above the buttons, so it rides the keyboard with them. */}
      {text || listening || attachments.staged.length > 0 ? null : <Starters onPick={startFrom} />}
      <AttachmentTray staged={attachments.staged} onRemove={attachments.remove} ring={color.bg} inset={16} />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          height: 56,
          marginHorizontal: 16,
          marginTop: 8,
          marginBottom: barBottom
        }}
      >
        {dictation.available ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={listening ? "Stop dictating" : "Dictate"}
            onPress={listening ? dictation.stop : startDictating}
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: listening ? color.need : color.s2,
              borderWidth: 1,
              borderColor: listening ? color.need : color.line2,
              alignItems: "center",
              justifyContent: "center"
            }}
          >
            <Icon name="mic" size={22} color={listening ? color.needInk : color.t1} />
          </Pressable>
        ) : null}
        {listening ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach a photo or file"
            onPress={attachments.attach}
            style={({ pressed }) => ({
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: pressed ? color.s3 : color.s2,
              borderWidth: 1,
              borderColor: color.line2,
              alignItems: "center",
              justifyContent: "center"
            })}
          >
            <Icon name="clip" size={22} color={color.t1} />
          </Pressable>
        )}
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 }}>
          {listening ? (
            <>
              <Bars />
              <Text style={{ fontSize: 14, color: color.t3 }}>
                <Text style={{ color: color.t1, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
                  {mmss(seconds)}
                </Text>
                {"  Listening"}
              </Text>
            </>
          ) : (
            <Text style={{ fontSize: 14, color: color.t3 }}>{wordCountLabel(text)}</Text>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!has || busy}
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
            opacity: busy ? 0.6 : 1
          }}
        >
          <Icon name="up" size={22} color={has ? color.black : color.t3} weight="semibold" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

/**
 * The page while dictating: the take in place at the cursor, settled words in
 * white, words still being recognized in gray, an amber caret after them. It
 * keeps the caret in view as the take grows. Tapping it stops dictating.
 */
function LiveText(props: {
  readonly before: string
  readonly settled: string
  readonly interim: string
  readonly after: string
  readonly startY: number
  readonly onPress: () => void
}) {
  const scroll = useRef<ScrollViewInstance>(null)
  const view = useRef({ height: 0, y: props.startY })
  const placed = useRef(false)
  const [caretY, setCaretY] = useState(0)

  useEffect(() => {
    const { height, y } = view.current
    if (!height) return
    const bottom = livePad.paddingTop + caretY
    if (bottom > y + height - 24) scroll.current?.scrollTo({ y: bottom - height + 24, animated: true })
    else if (bottom - lineHeight < y) scroll.current?.scrollTo({ y: Math.max(0, bottom - 2 * lineHeight) })
  }, [caretY])

  return (
    <ScrollView
      ref={scroll}
      style={{ flex: 1 }}
      onContentSizeChange={() => {
        if (placed.current) return
        placed.current = true
        scroll.current?.scrollTo({ y: props.startY, animated: false })
      }}
      contentContainerStyle={[livePad, { flexGrow: 1 }]}
      scrollEventThrottle={32}
      onLayout={(e) => {
        view.current.height = e.nativeEvent.layout.height
      }}
      onScroll={(e) => {
        view.current.y = e.nativeEvent.contentOffset.y
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Stop dictating and edit"
        onPress={props.onPress}
        style={{ flexGrow: 1 }}
      >
        {/* The text up to the caret, laid out the same but unseen: its height is where the caret is. */}
        <Text
          style={[page, { position: "absolute", left: 0, right: 0, top: 0, opacity: 0 }]}
          onLayout={(e) => setCaretY(e.nativeEvent.layout.height)}
          accessible={false}
          importantForAccessibility="no"
        >
          {props.before}
          {props.settled}
          {props.interim}
        </Text>
        <Text style={page}>
          {props.before}
          {props.settled}
          <Text style={{ color: color.t3 }}>{props.interim}</Text>
          <View
            style={{
              width: 2,
              height: 22,
              borderRadius: 1,
              backgroundColor: color.need,
              marginLeft: 2,
              transform: [{ translateY: 4 }]
            }}
          />
          {props.after}
        </Text>
      </Pressable>
    </ScrollView>
  )
}
