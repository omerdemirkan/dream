/**
 * Starters: a few one-line ideas, in the founder's order, under the placeholder
 * of a blank New idea page. Picking one never starts anything: it fills the
 * page with a draft to send or keep writing.
 */
import { Pressable, StyleSheet, Text } from "react-native"
import { type Idea, ideas } from "../data/ideas.ts"
import { SymbolIcon } from "./kit.tsx"
import { color, tracking } from "./theme.ts"

export function Starters(props: { readonly onPick: (idea: Idea) => void }) {
  return (
    <>
      <Text style={{ fontSize: 13, fontWeight: "600", color: color.t3, lineHeight: 28 }}>
        Or start from one of these
      </Text>
      {ideas.map((idea, i) => (
        <Pressable
          key={idea.id}
          accessibilityRole="button"
          accessibilityHint="Fills the page with a draft of this idea"
          onPress={() => props.onPick(idea)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 13,
            borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth * 2,
            borderTopColor: color.line,
            opacity: pressed ? 0.55 : 1
          })}
        >
          <SymbolIcon name={idea.symbol} size={17} />
          {/* Each line is written to fit (see ideas.ts); this only guards against larger text sizes. */}
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontSize: 16, lineHeight: 22, letterSpacing: tracking(-0.01, 16), color: color.t2 }}
          >
            {idea.line}
          </Text>
        </Pressable>
      ))}
    </>
  )
}
