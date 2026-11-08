/**
 * What a project's screen shows while its live connection isn't there yet: in the Status card's place before
 * anything has arrived, or as a line over the composer while it shows what it showed last.
 */
import { Pressable, Text, View } from "react-native"
import Animated, { FadeIn } from "react-native-reanimated"
import type { Connection } from "../data/ProjectStates.ts"
import { Dot, LinkButton } from "./kit.tsx"
import { color } from "./theme.ts"

/** The Status card's place before the first snapshot: a breathing dot, then a word, or that it can't get through. */
export function WaitingCard(props: {
  readonly connection: Connection
  readonly title: string | undefined
  readonly onRetry: () => void
}) {
  const failing = props.connection === "failing"
  return (
    <Animated.View
      entering={FadeIn.duration(240).delay(120)}
      style={{
        borderRadius: 24,
        borderWidth: 1,
        borderColor: color.line,
        backgroundColor: color.s1,
        paddingTop: failing ? 20 : 18,
        paddingHorizontal: 20,
        paddingBottom: failing ? 8 : 18
      }}
    >
      {failing ? (
        <Animated.View entering={FadeIn.duration(240)}>
          <Text style={{ fontSize: 17, fontWeight: "600", letterSpacing: -0.3, color: color.t1, marginBottom: 4 }}>
            Can’t reach Dream
          </Text>
          <Text style={{ fontSize: 15, lineHeight: 21, color: color.t2 }}>
            {`${props.title ?? "Your project"} keeps running.`}
          </Text>
          <LinkButton title="Try again" onPress={props.onRetry} />
        </Animated.View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 20 }}>
          <Dot kind="soft" />
          {props.connection === "slow" ? (
            <Animated.Text entering={FadeIn.duration(240)} style={{ fontSize: 15, color: color.t3 }}>
              Catching up
            </Animated.Text>
          ) : null}
        </View>
      )}
    </Animated.View>
  )
}

/** Over the composer while the screen shows what it showed last and the new snapshot is slow or not getting through. */
export function WaitingLine(props: { readonly connection: Connection; readonly onRetry: () => void }) {
  if (props.connection !== "slow" && props.connection !== "failing") return null
  const failing = props.connection === "failing"
  return (
    <Animated.View entering={FadeIn.duration(240)} style={{ alignItems: "center", marginBottom: 8 }}>
      <Pressable
        accessibilityRole={failing ? "button" : undefined}
        accessibilityHint={failing ? "Tries to reach Dream again" : undefined}
        disabled={!failing}
        onPress={props.onRetry}
        hitSlop={8}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, opacity: pressed ? 0.5 : 1 })}
      >
        {failing ? null : <Dot kind="soft" />}
        <Text style={{ fontSize: 13, color: color.t3 }}>
          {failing ? "Can’t reach Dream. Trying again." : "Catching up"}
        </Text>
      </Pressable>
    </Animated.View>
  )
}
