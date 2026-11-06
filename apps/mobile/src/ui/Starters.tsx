/**
 * Starters: a few one-line ideas, in the founder's order, as one row of cards
 * above New idea's buttons that scrolls sideways (the third card is cut by the
 * edge, so there's more to swipe). Picking one never starts anything: it fills
 * the page with a draft to send or keep writing.
 */
import { Pressable, ScrollView, Text } from "react-native"
import { type Idea, ideas } from "../data/ideas.ts"
import { SymbolIcon } from "./kit.tsx"
import { color, gutter, tracking } from "./theme.ts"

export function Starters(props: { readonly onPick: (idea: Idea) => void }) {
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, marginBottom: 2 }}
      contentContainerStyle={{ paddingHorizontal: gutter, gap: 10 }}
    >
      {ideas.map((idea) => (
        <Pressable
          key={idea.id}
          accessibilityRole="button"
          accessibilityHint="Fills the page with a draft of this idea"
          onPress={() => props.onPick(idea)}
          style={({ pressed }) => ({
            width: 158,
            height: 102,
            gap: 8,
            paddingVertical: 11,
            paddingHorizontal: 12,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: color.line,
            backgroundColor: pressed ? color.s2 : color.s1
          })}
        >
          <SymbolIcon name={idea.symbol} size={17} />
          {/* Room for three lines: most take two, and the longest words in ideas.ts can push one to three. */}
          <Text
            numberOfLines={3}
            style={{ fontSize: 14, lineHeight: 18, letterSpacing: tracking(-0.01, 14), color: color.t1 }}
          >
            {idea.line}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  )
}
