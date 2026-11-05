/**
 * The expanded message grows out of the card that was tapped and shrinks back
 * into its place in that project's Chat, which is then briefly highlighted.
 *
 * It sits above the navigator, so it can open from anywhere (Home's deck,
 * Status, Chat, a notification) while the project's Chat is put underneath it.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { usePathname, useRouter } from "expo-router"
import { useEffect, useRef } from "react"
import { StyleSheet, useWindowDimensions, View } from "react-native"
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming
} from "react-native-reanimated"
import { scheduleOnRN } from "react-native-worklets"
import { projectsAtom } from "../state/atoms.ts"
import { type Focus, focusAtom, landingAtom, messageRects, type Rect } from "../state/ui.ts"
import { ExpandedAccess, ExpandedQuestion } from "./Expanded.tsx"
import { useMessage, useProject } from "./hooks.ts"
import { color } from "./theme.ts"

const easing = Easing.bezier(0.22, 0.8, 0.2, 1)
const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
    step(n)
  })

export function FocusOverlay() {
  const focus = Option.getOrUndefined(useAtomValue(focusAtom))
  if (!focus) return null
  return <FocusLayer key={`${focus.projectId}/${focus.messageId}`} focus={focus} />
}

function FocusLayer(props: { readonly focus: Focus }) {
  const { focus } = props
  const { width: W, height: H } = useWindowDimensions()
  const router = useRouter()
  const pathname = usePathname()
  const setFocus = useAtomSet(focusAtom)
  const setLanding = useAtomSet(landingAtom)
  const message = useMessage(focus.projectId, focus.messageId, focus.message)
  const live = useProject(focus.projectId)
  const summaries = Option.getOrUndefined(AsyncResult.value(useAtomValue(projectsAtom)))
  const project = live?.project ?? summaries?.find((s) => s.project.id === focus.projectId)?.project

  const start: Rect = focus.origin ?? { x: 0, y: H * 0.05, width: W, height: H }
  // The animated styles close over this rather than `focus`, whose message worklets can't copy.
  const grows = focus.origin !== undefined
  const box = useSharedValue<Rect>(start)
  const progress = useSharedValue(0)
  const fade = useSharedValue(0)
  const closing = useRef(false)
  const expanded = useRef(false)
  const pathnameRef = useRef(pathname)
  pathnameRef.current = pathname

  const land = (highlight: boolean) =>
    setLanding(Option.some({ projectId: focus.projectId, messageId: focus.messageId, highlight, at: Date.now() }))

  /** Once it fills the screen, put that project's Chat underneath, scrolled to this message. */
  const onExpanded = () => {
    if (closing.current) return
    expanded.current = true
    land(false)
    if (pathnameRef.current === `/project/${focus.projectId}`) router.setParams({ tab: "chat" })
    else router.push({ pathname: "/project/[id]", params: { id: focus.projectId, tab: "chat", instant: "1" } })
  }

  useEffect(() => {
    progress.value = withTiming(1, { duration: focus.origin ? 500 : 340, easing }, (finished) => {
      if (finished) scheduleOnRN(onExpanded)
    })
    fade.value = focus.origin
      ? withSequence(withTiming(0, { duration: 150 }), withTiming(1, { duration: 350 }))
      : withTiming(1, { duration: 280 })
    // Runs once per expanded message (the layer is keyed by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A link or notification can name a message the project doesn't have (or one that isn't an ask):
  // once the project has loaded, there's nothing to expand, so don't cover the screen with an empty layer.
  const expandable = message?._tag === "Question" || message?._tag === "Access"
  useEffect(() => {
    if (live !== undefined && !expandable) setFocus(Option.none())
  }, [live, expandable, setFocus])

  // A link or notification that goes somewhere else (another project, Home) leaves this message behind.
  useEffect(() => {
    if (expanded.current && !closing.current && pathname !== `/project/${focus.projectId}`) setFocus(Option.none())
  }, [pathname, focus.projectId, setFocus])

  const finish = () => {
    setFocus(Option.none())
    land(true)
  }

  const back = () => {
    if (closing.current) return
    closing.current = true
    land(false)
    void frames(3)
      .then(() => messageRects.get(focus.messageId)?.())
      .then((rect) => {
        if (rect) {
          box.value = rect
          progress.value = withTiming(0, { duration: 440, easing }, (finished) => {
            if (finished) scheduleOnRN(finish)
          })
          fade.value = withTiming(0, { duration: 154 })
        } else {
          box.value = { x: 0, y: H * 0.05, width: W, height: H }
          progress.value = withTiming(0, { duration: 260, easing })
          fade.value = withTiming(0, { duration: 220 }, (finished) => {
            if (finished) scheduleOnRN(finish)
          })
        }
      })
  }

  const container = useAnimatedStyle(() => {
    const p = progress.value
    const b = box.value
    return {
      left: b.x * (1 - p),
      top: b.y * (1 - p),
      width: b.width + (W - b.width) * p,
      height: b.height + (H - b.height) * p,
      borderRadius: 24 * (1 - p),
      backgroundColor: interpolateColor(p, [0, 1], [color.s1, color.bg]),
      opacity: grows ? 1 : Math.min(1, fade.value * 1.4)
    }
  })
  const inner = useAnimatedStyle(() => {
    const p = progress.value
    const b = box.value
    return { left: -b.x * (1 - p), top: -b.y * (1 - p), opacity: fade.value }
  })

  return (
    // Modal for VoiceOver: the screen underneath (the project's Chat) isn't read while this is open.
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" accessibilityViewIsModal>
      <Animated.View style={[{ position: "absolute", overflow: "hidden" }, container]}>
        <Animated.View style={[{ position: "absolute", width: W, height: H }, inner]}>
          {message?._tag === "Question" ? (
            <ExpandedQuestion message={message} project={project} onBack={back} />
          ) : message?._tag === "Access" ? (
            <ExpandedAccess message={message} project={project} onBack={back} />
          ) : null}
        </Animated.View>
      </Animated.View>
    </View>
  )
}
