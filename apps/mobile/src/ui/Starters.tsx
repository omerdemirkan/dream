/**
 * Starters (Deck v3 inspiration, option A): a few one-line ideas, in the
 * founder's order, under the placeholder of a blank New idea page. Picking one
 * never starts anything: it puts an editable draft on the page.
 */
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { type Idea, ideas, startersFor } from "../data/ideas.ts"
import { projectsAtom } from "../state/atoms.ts"
import { SymbolIcon } from "./kit.tsx"
import { color, tracking } from "./theme.ts"

/** They wait for the projects, so a starter one of them already is doesn't vanish under a finger. */
export function Starters(props: { readonly onPick: (idea: Idea) => void }) {
  const projectsResult = useAtomValue(projectsAtom)
  const titles = Option.getOrElse(AsyncResult.value(projectsResult), () => []).map((s) => s.project.title)
  const shown = startersFor(ideas, titles)
  if (AsyncResult.isInitial(projectsResult) || shown.length === 0) return null
  return (
    <View>
      <Text style={{ fontSize: 13, fontWeight: "600", color: color.t3, lineHeight: 28 }}>
        Or start from one of these
      </Text>
      {shown.map((idea, i) => (
        <Pressable
          key={idea.id}
          accessibilityRole="button"
          accessibilityHint="Puts a draft of this idea on New idea to edit"
          onPress={() => props.onPick(idea)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 12,
            paddingVertical: 12,
            borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth * 2,
            borderTopColor: color.line,
            opacity: pressed ? 0.55 : 1
          })}
        >
          <View style={{ marginTop: 2 }}>
            <SymbolIcon name={idea.symbol} size={17} />
          </View>
          <Text style={{ flex: 1, fontSize: 16, lineHeight: 22, letterSpacing: tracking(-0.01, 16), color: color.t2 }}>
            {idea.line}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}
