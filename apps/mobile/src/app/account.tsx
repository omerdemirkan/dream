/**
 * The account, from Settings (direction B): who's signed in and since when, and Sign out.
 */
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Text, View } from "react-native"
import { accountView } from "../data/settings.ts"
import { sessionAtom, signOutFn } from "../state/atoms.ts"
import { useAction } from "../ui/actions.ts"
import { DetailScreen } from "../ui/DetailScreen.tsx"
import { ActionRow, Group } from "../ui/Group.tsx"
import { color, tracking } from "../ui/theme.ts"

export default function Account() {
  const session = Option.getOrUndefined(Option.flatten(AsyncResult.value(useAtomValue(sessionAtom))))
  const signOut = useAction(signOutFn)
  const account = accountView(session?.user)
  const initial = account.title.trim().charAt(0).toUpperCase()
  return (
    <DetailScreen title="Account">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 6 }}>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: color.s2,
            borderWidth: 1,
            borderColor: color.line,
            alignItems: "center",
            justifyContent: "center"
          }}
        >
          <Text style={{ fontSize: 20, fontWeight: "600", color: color.t1 }}>{initial}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text
            accessibilityRole="header"
            style={{ fontSize: 22, fontWeight: "700", letterSpacing: tracking(-0.03, 22), color: color.t1 }}
          >
            {account.title}
          </Text>
          {account.subtitle ? (
            <Text style={{ fontSize: 14, color: color.t2, marginTop: 2 }}>{account.subtitle}</Text>
          ) : null}
        </View>
      </View>
      {account.since ? <Text style={{ fontSize: 14, color: color.t3, marginTop: 16 }}>{account.since}</Text> : null}
      <Group style={{ marginTop: 24 }}>
        <ActionRow title="Sign out" busy={signOut.busy} onPress={() => signOut.run(undefined)} />
      </Group>
    </DetailScreen>
  )
}
