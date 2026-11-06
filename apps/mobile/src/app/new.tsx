/**
 * New idea: the page (Deck v3, option A). The whole page below the nav is one
 * field: tap anywhere to write, put the cursor anywhere, select, edit. The mic
 * dictates in at the cursor (or over the selection), showing settled words and
 * the ones still being recognized in place; a pause doesn't stop it. Tapping
 * the text while dictating stops and keeps what was heard, with the cursor
 * after it. Return is a new line; only Send sends, and it lands in the new
 * project's Chat with the idea as its first message.
 *
 * While the page is blank, starters sit under the placeholder (Deck v3
 * inspiration, option A). Tapping one puts its draft on the page with the
 * guesses tinted and the first selected, so typing replaces it; a chip by Send
 * names where it came from, and its × clears the page.
 *
 * `/new?starter=<idea id>` opens with a draft, `/new?starters=more&group=<group>` with More open.
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
import Animated, { FadeIn } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { caretAt, ideaToSend, insertAt, placeTake, type Selection, wordCountLabel } from "../data/draft.ts"
import { draftRuns, type Idea, ideaGroups, ideas, parseDraft, shiftGuesses } from "../data/ideas.ts"
import { longIdea } from "../fake/fixtures.ts"
import { useDictation } from "../platform/dictation.ts"
import { createProjectFn } from "../state/atoms.ts"
import { askPushAtom } from "../state/ui.ts"
import { useAction, useToast } from "../ui/actions.ts"
import { useRequestId } from "../ui/hooks.ts"
import { Bars, Icon, IconButton, SymbolIcon } from "../ui/kit.tsx"
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
/** A guess in a draft from a starter, until it's edited (`.g` in the mock). */
const guessStyle: TextStyle = { backgroundColor: "rgba(255,179,92,0.16)", color: "#FFD9AE" }

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
    starters?: string
    group?: string
  }>()
  const insets = useSafeAreaInsets()
  const barBottom = Math.max(insets.bottom, 12) + 2
  const [opened] = useState(() => {
    const idea = ideas.find((i) => i.id === params.starter)
    return idea ? { idea, ...parseDraft(idea.draft) } : undefined
  })
  const [text, setText] = useState(() => opened?.text ?? params.text ?? (params.sample === "long" ? longIdea : ""))
  const textRef = useRef(text)
  textRef.current = text
  /** The guesses still standing in a draft from a starter, and which starter it was. */
  const [guesses, setGuesses] = useState<ReadonlyArray<Selection>>(opened?.guesses ?? [])
  const [source, setSource] = useState<Idea | undefined>(opened?.idea)
  /** Puts new text on the page, keeping the guesses the edit didn't touch. */
  const edit = (next: string) => {
    const previous = textRef.current
    textRef.current = next
    setGuesses((g) => shiftGuesses(g, previous, next))
    if (!next) setSource(undefined)
    setText(next)
  }
  const input = useRef<TextInputInstance>(null)
  /** Where the cursor is (or was, when the field last had focus). */
  const selection = useRef<Selection>(opened?.guesses[0] ?? caretAt(text.length))
  /** A selection to make once the field has the text it's for (a starter's first guess). */
  const select = useRef<Selection | null>(null)
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
  const requestId = useRequestId()
  const toast = useToast()
  const askPush = useAtomSet(askPushAtom)
  const dictation = useDictation((heard) => {
    const placed = insertAt(textRef.current, anchorRef.current, heard)
    caretAfter.current = placed.caret
    edit(placed.text)
  }, "Scale any recipe up or down, and keep the ingredient math honest. Eggs don’t come in halves, and a pinch stays a pinch.")
  const listening = dictation.listening
  const seconds = useSeconds(listening)
  const idea = ideaToSend(text, anchor, listening ? dictation.transcript : undefined)
  const has = idea.length > 0

  useEffect(() => {
    if (params.dictate) {
      const id = setTimeout(startDictating, 450)
      return () => clearTimeout(id)
    }
    const id = setTimeout(() => {
      input.current?.focus()
      if (opened?.guesses[0]) input.current?.setSelection(opened.guesses[0].start, opened.guesses[0].end)
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

  // A starter's draft is on the page: select its first guess, so typing replaces it.
  useEffect(() => {
    const at = select.current
    if (!at) return
    select.current = null
    const id = requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelection(at.start, at.end)
    })
    return () => cancelAnimationFrame(id)
  }, [text])

  function startFrom(idea: Idea) {
    const draft = parseDraft(idea.draft)
    const first = draft.guesses[0] ?? caretAt(draft.text.length)
    textRef.current = draft.text
    selection.current = first
    select.current = first
    setGuesses(draft.guesses)
    setSource(idea)
    setText(draft.text)
  }

  function clearDraft() {
    edit("")
    selection.current = caretAt(0)
    input.current?.focus()
  }

  function startDictating() {
    setAnchor(selection.current)
    // The field gives way to the live text, which also ends the keyboard's own dictation, so the two never share the mic.
    input.current?.blur()
    dictation.toggle()
  }

  const send = () => {
    if (!idea || create.busy) return
    if (listening) {
      // Everything heard so far goes in where it was landing, so a failed send leaves the whole idea on the page.
      refocus.current = false
      edit(placeTake(text, anchor, dictation.transcript).text)
      dictation.cancel()
    }
    create.run(
      { idea, requestId: requestId.for(idea) },
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
          // While a draft has guesses, the text is drawn as runs so they can be tinted; otherwise it's a plain value.
          value={guesses.length > 0 ? undefined : text}
          onChangeText={edit}
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
        >
          {guesses.length > 0
            ? draftRuns(text, guesses).map((run, i) => (
                <Text key={i} style={run.guess ? guessStyle : undefined}>
                  {run.text}
                </Text>
              ))
            : undefined}
        </TextInput>
        {text || listening ? null : (
          <Animated.View
            entering={FadeIn.duration(220)}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              top: livePad.paddingTop + 2 * lineHeight + 26
            }}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 8, paddingBottom: 24 }}
            >
              <Starters
                more={params.starters === "more"}
                group={ideaGroups.find((g) => g.id === params.group)?.id}
                onPick={startFrom}
              />
            </ScrollView>
          </Animated.View>
        )}
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
          ) : source && text ? (
            <SourceChip idea={source} onClear={clearDraft} />
          ) : (
            <Text style={{ fontSize: 14, color: color.t3 }}>{wordCountLabel(text)}</Text>
          )}
        </View>
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

/** By Send, while a starter's draft is on the page: which one, and × to clear the page. */
function SourceChip(props: { readonly idea: Idea; readonly onClear: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Clear the ${props.idea.title} draft`}
      onPress={props.onClear}
      hitSlop={8}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        height: 30,
        paddingLeft: 12,
        paddingRight: 9,
        borderRadius: 15,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.line,
        maxWidth: "100%"
      }}
    >
      <SymbolIcon name={props.idea.symbol} size={13} />
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: color.t2 }}>
        {props.idea.title}
      </Text>
      <Icon name="close" size={11} color={color.t3} weight="semibold" />
    </Pressable>
  )
}
