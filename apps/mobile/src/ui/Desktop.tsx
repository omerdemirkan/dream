/**
 * "Finish on a computer": an access request they'd rather do at a desk (a long key, a developer console) goes to
 * their email as a link, only when they ask (`EmailAccessLink`). Before, it's a labelled row on the card; after,
 * the row says where it went and whether it's been opened, with a way to send it again.
 */
import { type AccessMessage, canFinishOnDesktop } from "@dream/domain"
import { ActivityIndicator, Pressable, type StyleProp, Text, View, type ViewStyle } from "react-native"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { Option } from "effect"
import { emailAccessLinkFn, featuresAtom } from "../state/atoms.ts"
import { useAction } from "./actions.ts"
import { desktopStatus, linkMinutes } from "./desktopStatus.ts"
import { Icon } from "./kit.tsx"
import { color } from "./theme.ts"

export function FinishOnComputer(props: { readonly message: AccessMessage; readonly style?: StyleProp<ViewStyle> }) {
  const m = props.message
  const send = useAction(emailAccessLinkFn)
  // Shown only once this deployment sends email, and for requests still waiting.
  const features = Option.getOrUndefined(AsyncResult.value(useAtomValue(featuresAtom)))
  if (features?.emailLinks !== true || !canFinishOnDesktop(m)) return null
  const run = () => {
    if (!send.busy) send.run({ projectId: m.projectId, messageId: m.id })
  }
  const status = desktopStatus(m, Date.now())
  if (status._tag === "NotSent") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Finish on a computer. Email me a link."
        onPress={run}
        style={({ pressed }) => [
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            minHeight: 52,
            marginTop: 10,
            paddingHorizontal: 14,
            paddingVertical: 9,
            borderRadius: 15,
            borderWidth: 1,
            borderColor: color.line2,
            backgroundColor: pressed ? color.s2 : "transparent"
          },
          props.style
        ]}
      >
        <Icon name="laptop" size={18} color={color.t2} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: "600", color: color.t1 }}>Finish on a computer</Text>
          <Text style={{ fontSize: 13, color: color.t2, marginTop: 1 }}>Email me a link</Text>
        </View>
        {send.busy ? (
          <ActivityIndicator size="small" color={color.t2} />
        ) : (
          <Icon name="mail" size={16} color={color.t3} />
        )}
      </Pressable>
    )
  }
  const detail =
    status._tag === "Opened"
      ? "Opened on a computer. Finish it there, or here."
      : status._tag === "Expired"
        ? "That link has expired."
        : `Open it on your computer. It works once, for ${linkMinutes} minutes.`
  return (
    <View
      accessible
      accessibilityLabel={`${status._tag === "Opened" ? "Link opened" : `Link sent to ${status.to}`}. ${detail}`}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          marginTop: 10,
          paddingLeft: 14,
          paddingRight: 8,
          paddingVertical: 10,
          borderRadius: 15,
          backgroundColor: color.s1,
          borderWidth: 1,
          borderColor: color.line
        },
        props.style
      ]}
    >
      <Icon name={status._tag === "Opened" ? "laptop" : "mail"} size={18} color={color.cool} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} ellipsizeMode="middle" style={{ fontSize: 14, fontWeight: "600", color: color.t1 }}>
          {status._tag === "Opened" ? "Opened on your computer" : `Sent to ${status.to}`}
        </Text>
        <Text style={{ fontSize: 13, lineHeight: 17, color: color.t2, marginTop: 1 }}>{detail}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={run}
        hitSlop={6}
        style={({ pressed }) => ({
          height: 32,
          paddingHorizontal: 12,
          borderRadius: 16,
          justifyContent: "center",
          backgroundColor: color.s3,
          opacity: pressed || send.busy ? 0.7 : 1
        })}
      >
        {send.busy ? (
          <ActivityIndicator size="small" color={color.t1} />
        ) : (
          <Text style={{ fontSize: 13, fontWeight: "600", color: color.t1 }}>Send again</Text>
        )}
      </Pressable>
    </View>
  )
}
