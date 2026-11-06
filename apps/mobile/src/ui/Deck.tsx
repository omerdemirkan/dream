/**
 * Home's needs-you deck: one card at a time, from every project, answerable
 * right there. Tap the heading to expand it; answers can be undone for a few
 * seconds.
 */
import { type AccessMessage, accessHeading, type OpenAsk, type QuestionMessage } from "@dream/domain"
import { useAtomSet } from "@effect/atom-react"
import { useEffect, useRef, useState } from "react"
import { type HostInstance, Pressable, Text, View } from "react-native"
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated"
import { scheduleOnRN } from "react-native-worklets"
import { answerUndoableFn } from "../state/atoms.ts"
import { askPushAtom } from "../state/ui.ts"
import { useSignInAccess, useToast } from "./actions.ts"
import { accessExplainer } from "./describe.ts"
import { useOpenMessage } from "./hooks.ts"
import { Choices, GoogleButton, Icon, SignInButton, Tile } from "./kit.tsx"
import { MarkdownText } from "./Markdown.tsx"
import { ReadMore } from "./Messages.tsx"
import { color, needGlow } from "./theme.ts"

const cardShell = {
  borderRadius: 28,
  paddingTop: 18,
  paddingHorizontal: 16,
  paddingBottom: 16,
  backgroundColor: color.s1,
  experimental_backgroundImage: needGlow,
  borderWidth: 1,
  borderColor: color.needLine
} as const

function Who(props: { readonly ask: OpenAsk; readonly label: string; readonly onOpen: () => void }) {
  return (
    <Pressable
      onPress={props.onOpen}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 2 }}
    >
      <Tile icon={props.ask.project.icon} size="sm" />
      <Text style={{ fontSize: 14, fontWeight: "600", color: color.t1 }}>{props.ask.project.title}</Text>
      <Text style={{ fontSize: 13, color: color.t3 }}>{props.label}</Text>
      <View style={{ flex: 1 }} />
      <Icon name="expand" size={15} color={color.t3} />
    </Pressable>
  )
}

/** The heading and its TL;DR, clamped: one that runs long steps down a size, and the rest opens on a tap. */
function Heading(props: {
  readonly title: string
  readonly tldr: string | undefined
  readonly context?: string | undefined
  readonly onOpen: () => void
}) {
  const [cut, setCut] = useState<Record<string, boolean>>({})
  const track = (part: string) => (clamped: boolean) =>
    setCut((parts) => (parts[part] === clamped ? parts : { ...parts, [part]: clamped }))
  const long = props.title.length > 100
  return (
    <Pressable onPress={props.onOpen} accessibilityRole="button" accessibilityHint="Opens it full screen">
      <MarkdownText
        source={props.title}
        numberOfLines={long ? 5 : 4}
        onClamp={track("title")}
        style={{
          fontSize: long ? 19 : 25,
          lineHeight: long ? 24 : 28.5,
          fontWeight: long ? "600" : "700",
          letterSpacing: long ? -0.4 : -0.75,
          color: color.t1,
          marginTop: 13,
          marginBottom: 7,
          marginHorizontal: 2
        }}
      />
      {props.tldr ? (
        <MarkdownText
          source={props.tldr}
          numberOfLines={2}
          onClamp={track("tldr")}
          style={{ fontSize: 14.5, lineHeight: 20.6, color: color.t2, marginHorizontal: 2 }}
        />
      ) : null}
      {props.context ? (
        <MarkdownText
          source={props.context}
          numberOfLines={3}
          onClamp={track("context")}
          style={{ fontSize: 14.5, lineHeight: 20.6, color: color.t1, marginTop: 8, marginHorizontal: 2 }}
        />
      ) : null}
      {Object.values(cut).some(Boolean) ? <ReadMore onOpen={props.onOpen} /> : null}
    </Pressable>
  )
}

function QuestionFront(props: {
  readonly ask: OpenAsk
  readonly message: QuestionMessage
  readonly onOpen: () => void
  readonly onAnswer: (option: string) => void
}) {
  const [picked, setPicked] = useState<string | undefined>(undefined)
  return (
    <>
      <Who ask={props.ask} label="Question" onOpen={props.onOpen} />
      <Heading
        title={props.message.question}
        tldr={props.message.why}
        context={props.message.context}
        onOpen={props.onOpen}
      />
      <Choices
        options={props.message.options}
        selected={picked}
        style={{ marginTop: 14 }}
        onPick={(option) => {
          if (picked) return
          setPicked(option)
          props.onAnswer(option)
        }}
      />
    </>
  )
}

function AccessFront(props: { readonly ask: OpenAsk; readonly message: AccessMessage; readonly onOpen: () => void }) {
  const signIn = useSignInAccess(props.message)
  const heading = accessHeading(props.message)
  return (
    <>
      <Who ask={props.ask} label="Access" onOpen={props.onOpen} />
      <Heading title={heading.title} tldr={heading.reason ?? accessExplainer(props.message)} onOpen={props.onOpen} />
      {props.message.request._tag === "Google" ? (
        <GoogleButton compact busy={signIn.busy} onPress={signIn.start} />
      ) : props.message.request._tag === "OAuth" ? (
        <SignInButton compact service={signIn.service} busy={signIn.busy} onPress={signIn.start} />
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={props.onOpen}
          style={({ pressed }) => ({
            marginTop: 16,
            height: 50,
            borderRadius: 25,
            backgroundColor: color.t1,
            alignItems: "center",
            justifyContent: "center",
            transform: pressed ? [{ scale: 0.98 }] : []
          })}
        >
          <Text style={{ fontSize: 16, fontWeight: "600", color: color.black }}>
            {props.message.request._tag === "Apple"
              ? "Add App Store Connect key"
              : `Add ${props.message.request.service} key`}
          </Text>
        </Pressable>
      )}
    </>
  )
}

function FrontCard(props: {
  readonly ask: OpenAsk
  readonly fresh: boolean
  readonly onLeft: (option: string) => void
}) {
  const ref = useRef<HostInstance>(null)
  const open = useOpenMessage()
  const x = useSharedValue(0)
  const enter = useSharedValue(props.fresh ? 0 : 1)
  useEffect(() => {
    enter.value = withTiming(1, { duration: 400, easing: Easing.bezier(0.2, 0.8, 0.2, 1) })
  }, [enter])
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(0.4 + enter.value * 0.6, 1 - x.value),
    transform: [
      { translateX: `${-120 * x.value}%` },
      { translateY: 12 * (1 - enter.value) },
      { scale: 0.95 + 0.05 * enter.value },
      { rotate: `${-5 * x.value}deg` }
    ]
  }))
  const m = props.ask.message
  const onOpen = () => open({ projectId: m.projectId, messageId: m.id, message: m, from: ref })
  // Worklets copy what they close over, so they get the callback rather than all of props.
  const onLeft = props.onLeft
  const onAnswer = (option: string) => {
    setTimeout(() => {
      x.value = withTiming(1, { duration: 340, easing: Easing.bezier(0.5, 0, 0.8, 0.4) }, (finished) => {
        if (finished) scheduleOnRN(onLeft, option)
      })
    }, 380)
  }
  return (
    <Animated.View ref={ref} style={[cardShell, { zIndex: 1 }, style]}>
      {m._tag === "Question" ? (
        <QuestionFront ask={props.ask} message={m} onOpen={onOpen} onAnswer={onAnswer} />
      ) : (
        <AccessFront ask={props.ask} message={m} onOpen={onOpen} />
      )}
    </Animated.View>
  )
}

/** Progress through this sitting's asks: answered, current, waiting. */
export function Segments(props: { readonly done: number; readonly remaining: number }) {
  const total = Math.min(6, props.done + props.remaining)
  return (
    <View
      style={{ flexDirection: "row", gap: 4 }}
      accessibilityLabel={`${props.done} answered, ${props.remaining} waiting`}
    >
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={{
            width: 22,
            height: 3,
            borderRadius: 2,
            backgroundColor:
              i < props.done
                ? "rgba(255,255,255,0.4)"
                : i === props.done && props.remaining > 0
                  ? color.need
                  : "rgba(255,255,255,0.13)"
          }}
        />
      ))}
    </View>
  )
}

export function Deck(props: { readonly asks: ReadonlyArray<OpenAsk>; readonly onAnswered: () => void }) {
  const answer = useAtomSet(answerUndoableFn)
  const askPush = useAtomSet(askPushAtom)
  const toast = useToast()
  const [seen, setSeen] = useState<string | undefined>(undefined)
  const front = props.asks[0]
  const fresh = front !== undefined && seen !== undefined && seen !== front.message.id
  useEffect(() => {
    if (front) setSeen(front.message.id)
  }, [front])
  if (!front) return null
  const behind = props.asks.length - 1
  return (
    <View style={{ marginBottom: 24 + Math.min(behind, 2) * 9 }}>
      {behind > 1 ? <Ghost inset={28} drop={18} opacity={0.5} /> : null}
      {behind > 0 ? <Ghost inset={14} drop={9} opacity={0.85} /> : null}
      <FrontCard
        key={front.message.id}
        ask={front}
        fresh={fresh}
        onLeft={(option) => {
          const m = front.message
          answer({ projectId: m.projectId, messageId: m.id, answer: { _tag: "Choice", option } })
          toast(`Sent to ${front.project.title}`, { undo: m.id, done: true })
          askPush((n) => n + 1)
          props.onAnswered()
        }}
      />
    </View>
  )
}

function Ghost(props: { readonly inset: number; readonly drop: number; readonly opacity: number }) {
  return (
    <View
      style={{
        position: "absolute",
        left: props.inset,
        right: props.inset,
        bottom: -props.drop,
        height: 44,
        borderBottomLeftRadius: 26,
        borderBottomRightRadius: 26,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.line,
        opacity: props.opacity
      }}
    />
  )
}
