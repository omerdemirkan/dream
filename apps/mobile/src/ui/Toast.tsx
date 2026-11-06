/**
 * The toast above the dock: "Sent to Cabin · Undo", or a one-line failure.
 */
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef } from "react"
import { Pressable, Text } from "react-native"
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { answerFailuresAtom, restoreProjectFn, undoAnswerFn } from "../state/atoms.ts"
import { useAction } from "./actions.ts"
import { toastAtom } from "../state/ui.ts"
import { Icon } from "./kit.tsx"
import { color } from "./theme.ts"

const lifetime = 4200

export function Toast() {
  const [toast, setToast] = useAtom(toastAtom)
  const undo = useAtomSet(undoAnswerFn)
  const restore = useAction(restoreProjectFn)
  const insets = useSafeAreaInsets()
  const shown = useSharedValue(0)
  const current = Option.getOrUndefined(toast)
  const last = useRef(current)
  if (current) last.current = current
  const visible = last.current

  // Answers that failed after their undo window closed.
  const failure = Option.getOrUndefined(AsyncResult.value(useAtomValue(answerFailuresAtom)))
  useEffect(() => {
    if (failure)
      setToast(
        Option.some({ message: `Couldn’t send your answer: ${failure.message}`, undo: undefined, at: Date.now() })
      )
  }, [failure, setToast])

  useEffect(() => {
    if (!current) {
      shown.value = withTiming(0, { duration: 280, easing: Easing.bezier(0.2, 0.8, 0.2, 1) })
      return
    }
    shown.value = withTiming(1, { duration: 280, easing: Easing.bezier(0.2, 0.8, 0.2, 1) })
    const id = setTimeout(() => setToast(Option.none()), lifetime)
    return () => clearTimeout(id)
  }, [current, setToast, shown])

  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateY: (1 - shown.value) * 10 }]
  }))

  if (!visible) return null
  return (
    <Animated.View
      pointerEvents={current ? "auto" : "none"}
      style={[
        {
          position: "absolute",
          left: 16,
          right: 16,
          bottom: insets.bottom + 78,
          backgroundColor: color.toast,
          borderWidth: 1,
          borderColor: color.line2,
          borderRadius: 16,
          paddingVertical: 12,
          paddingLeft: 16,
          paddingRight: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          boxShadow: "0 12px 30px rgba(0,0,0,0.5)"
        },
        style
      ]}
    >
      {visible.done ? <Icon name="check" size={16} /> : <Icon name="warn" size={16} color={color.need} />}
      <Text style={{ flex: 1, fontSize: 14.5, color: color.t1 }}>{visible.message}</Text>
      {visible.undo || visible.restore ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            if (visible.undo) undo(visible.undo)
            if (visible.restore) restore.run(visible.restore)
            setToast(Option.none())
          }}
        >
          <Text style={{ fontWeight: "600", color: color.need, paddingVertical: 4, paddingHorizontal: 6 }}>Undo</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  )
}
