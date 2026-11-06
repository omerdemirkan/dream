/**
 * "Don't connect" on an access request opens a small sheet: why not, as a one-tap reason or their own words
 * (typed or dictated), then the same "Don't connect" to confirm. The reason is optional, so declining without
 * one is a single extra tap. The agent hears it with the event; the card shows it.
 */
import type { AccessMessage } from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { useState } from "react"
import { Modal, Pressable, StyleSheet, Text, View } from "react-native"
import { KeyboardAvoidingView } from "react-native-keyboard-controller"
import Animated, { Easing, SlideInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { declineAccessFn } from "../state/atoms.ts"
import { declineAtom } from "../state/ui.ts"
import { useAction } from "./actions.ts"
import { ReasonField } from "./Composer.tsx"
import { accessLabel } from "./describe.ts"
import { Button, Icon, LinkButton } from "./kit.tsx"
import { color } from "./theme.ts"

/** The one-tap reasons. A sign-in they don't use reads better than a key they don't have. */
export const declineReasons = (message: AccessMessage): ReadonlyArray<string> => [
  message.request._tag === "Google" || message.request._tag === "OAuth"
    ? `I don’t use ${accessLabel(message.request)}`
    : "I don’t have one",
  "I’d rather not share this",
  "Use a free option instead",
  "Not now"
]

/** Opens the decline sheet for this access request (one sheet for the app, in `DeclineHost`). */
export function useDecline(message: AccessMessage) {
  const set = useAtomSet(declineAtom)
  return { open: () => set(Option.some(message)) }
}

/** The decline sheet, above everything (the expanded view too); `_layout` puts it there. */
export function DeclineHost() {
  const asked = Option.getOrUndefined(useAtomValue(declineAtom))
  const set = useAtomSet(declineAtom)
  const [shown, setShown] = useState<AccessMessage | undefined>(undefined)
  if (asked && asked !== shown) setShown(asked)
  if (!shown) return null
  return (
    <DeclineSheet
      key={shown.id}
      message={shown}
      visible={asked !== undefined}
      onClose={() => set(Option.none())}
      onClosed={() => setShown(undefined)}
    />
  )
}

function DeclineSheet(props: {
  readonly message: AccessMessage
  readonly visible: boolean
  readonly onClose: () => void
  readonly onClosed: () => void
}) {
  const m = props.message
  const insets = useSafeAreaInsets()
  const decline = useAction(declineAccessFn)
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const [typed, setTyped] = useState("")
  const reason = typed.trim() || picked
  const confirm = () =>
    decline.run(
      { projectId: m.projectId, messageId: m.id, ...(reason ? { reason } : {}) },
      { onSuccess: props.onClose }
    )
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={props.onClose}
      onDismiss={props.onClosed}
    >
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={-(insets.bottom - 6)}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        <Pressable
          accessibilityLabel="Cancel"
          onPress={props.onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.6)" }]}
        />
        <Animated.View
          entering={SlideInDown.duration(320).easing(Easing.bezier(0.22, 0.8, 0.2, 1).factory())}
          accessibilityViewIsModal
          style={{
            backgroundColor: color.s1,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderTopWidth: 1,
            borderColor: color.line2,
            paddingTop: 10,
            paddingHorizontal: 20,
            paddingBottom: Math.max(insets.bottom, 12)
          }}
        >
          <View style={{ alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: color.line2 }} />
          <Text style={{ marginTop: 18, fontSize: 24, fontWeight: "700", letterSpacing: -0.6, color: color.t1 }}>
            Why not?
          </Text>
          <Text style={{ marginTop: 6, fontSize: 15, lineHeight: 21, color: color.t2 }}>
            Optional. Dream tells the agent, so it can work around it.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
            {declineReasons(m).map((option) => {
              const on = picked === option && !typed.trim()
              return (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={() => {
                    setPicked(on ? undefined : option)
                    setTyped("")
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                    borderRadius: 20,
                    backgroundColor: on ? color.t1 : pressed ? color.s3 : color.s2,
                    borderWidth: 1,
                    borderColor: on ? color.t1 : color.line
                  })}
                >
                  {on ? <Icon name="check" size={13} color={color.black} weight="bold" /> : null}
                  <Text style={{ fontSize: 15, fontWeight: on ? "600" : "400", color: on ? color.black : color.t1 }}>
                    {option}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          <View style={{ marginTop: 12 }}>
            <ReasonField value={typed} onChange={setTyped} sample="I'll make an account next week" />
          </View>
          <Button title="Don’t connect" busy={decline.busy} onPress={confirm} style={{ marginTop: 20 }} />
          <LinkButton title="Cancel" onPress={props.onClose} />
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
