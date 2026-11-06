/**
 * Starters (Deck v3 inspiration, option A): four one-line ideas, in the
 * founder's priority, and More, which lists them all by group. New
 * idea shows them under the placeholder of a blank page. Picking one never
 * starts anything: it puts an editable draft on the page.
 */
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useMemo, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { connectedNeeds, type Idea, type IdeaGroup, ideaGroups, ideas, pickStarters, rankIdeas } from "../data/ideas.ts"
import { integrationsAtom, projectsAtom } from "../state/atoms.ts"
import { Icon, SymbolIcon } from "./kit.tsx"
import { color, gutter, tracking } from "./theme.ts"

const listOf = <A,>(result: AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>): ReadonlyArray<A> =>
  Option.getOrElse(AsyncResult.value(result), (): ReadonlyArray<A> => [])

/** They wait for the projects and connections, so the four don't change under a finger. */
export function Starters(props: {
  readonly onPick: (idea: Idea) => void
  /** Opens with More showing (all of them, or one group). */
  readonly more?: boolean
  readonly group?: IdeaGroup | undefined
}) {
  const projectsResult = useAtomValue(projectsAtom)
  const integrationsResult = useAtomValue(integrationsAtom)
  const settled = !AsyncResult.isInitial(projectsResult) && !AsyncResult.isInitial(integrationsResult)
  const projects = listOf(projectsResult)
  const integrations = listOf(integrationsResult)
  const [seed] = useState(Math.random)
  const [browsing, setBrowsing] = useState<IdeaGroup | "all" | undefined>(
    props.group ?? (props.more ? "all" : undefined)
  )
  const connected = useMemo(() => connectedNeeds(integrations), [integrations])
  const ranked = useMemo(
    () => rankIdeas(ideas, { connected, projectTitles: projects.map((s) => s.project.title) }),
    [connected, projects]
  )
  const four = useMemo(() => pickStarters(ranked, seed), [ranked, seed])
  if (!settled) return null
  const shown = browsing === undefined ? four : browsing === "all" ? ranked : ranked.filter((i) => i.group === browsing)
  return (
    <View>
      {browsing === undefined ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 28 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: color.t3 }}>Or start from one of these</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="More ideas"
            hitSlop={10}
            onPress={() => setBrowsing("all")}
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <Icon name="shuffle" size={13} color={color.t2} />
            <Text style={{ fontSize: 13, fontWeight: "600", color: color.t2 }}>More</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          style={{ marginHorizontal: -gutter, marginBottom: 4 }}
          contentContainerStyle={{ paddingHorizontal: gutter, gap: 8 }}
        >
          {[{ id: "all" as const, label: "All" }, ...ideaGroups].map((g) => {
            const on = browsing === g.id
            return (
              <Pressable
                key={g.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setBrowsing(g.id)}
                style={{
                  height: 32,
                  paddingHorizontal: 13,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: on ? color.t1 : color.line2,
                  backgroundColor: on ? color.t1 : "transparent",
                  justifyContent: "center"
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "500", color: on ? color.black : color.t2 }}>{g.label}</Text>
              </Pressable>
            )
          })}
        </ScrollView>
      )}
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
