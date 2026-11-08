/**
 * A full-screen detail opened from Settings (the costs card's "See more"): back on the left and the title centred,
 * as Settings and the plan breakdown (`app/plan`) have, over a scrolling page.
 */
import { useRouter } from "expo-router"
import type { ReactNode } from "react"
import { ScrollView, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { IconButton } from "./kit.tsx"
import { color, gutter } from "./theme.ts"

export function DetailScreen(props: { readonly title: string; readonly children: ReactNode }) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: color.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 4,
        paddingHorizontal: gutter,
        paddingBottom: insets.bottom + 40
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 44 }}>
        <IconButton icon="back" label="Back" onPress={() => router.back()} />
        <Text style={{ fontSize: 15, fontWeight: "600", color: color.t2 }}>{props.title}</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ marginTop: 14 }}>{props.children}</View>
    </ScrollView>
  )
}
