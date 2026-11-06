/**
 * Home: whatever needs them first (the deck), then their projects. The
 * composer at the bottom starts a new idea.
 */
import type { ModelConnection, OpenAsk, ProjectSummary } from "@dream/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Redirect, useRouter } from "expo-router"
import { useEffect, useState } from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { phaseLabel, providerName, usageLeft, usageLine } from "../data/format.ts"
import { dotOf, homeLine, presenceOf } from "../data/presence.ts"
import { modelConnectionsAtom, openAsksAtom, projectsAtom } from "../state/atoms.ts"
import { Deck, Segments } from "../ui/Deck.tsx"
import { usePendingAnswers } from "../ui/hooks.ts"
import { Dot, Icon, IconButton, LinkButton, Orb } from "../ui/kit.tsx"
import { plainText } from "../ui/markdownParse.ts"
import { PresenceTile, StateLineText, useTickingNow } from "../ui/Presence.tsx"
import { color, gutter } from "../ui/theme.ts"

const listOf = <A,>(result: AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>) =>
  Option.getOrElse(AsyncResult.value(result), (): ReadonlyArray<A> => [])

export default function Home() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const projectsResult = useAtomValue(projectsAtom)
  const projects = listOf(projectsResult)
  const pending = usePendingAnswers()
  const asksResult = useAtomValue(openAsksAtom)
  const refreshProjects = useAtomRefresh(projectsAtom)
  const refreshAsks = useAtomRefresh(openAsksAtom)
  const asks = listOf(asksResult).filter(
    (ask) => !pending.has(ask.message.id) && !(ask.message._tag === "Access" && ask.message.when)
  )
  const connectionsResult = useAtomValue(modelConnectionsAtom)
  const connections = listOf(connectionsResult)
  const [answered, setAnswered] = useState(0)
  const needs = asks.length > 0
  // Nothing to show and the last try failed (offline, the API down): say so rather than "All clear".
  const unreachable =
    !needs &&
    projects.length === 0 &&
    (AsyncResult.isFailure(projectsResult) || AsyncResult.isFailure(asksResult)) &&
    !projectsResult.waiting &&
    !asksResult.waiting

  // While an agent is starting or working, Home checks back every so often, so its row moves on by itself.
  const busy = projects.some((s) => s.activity?.state === "starting" || s.activity?.state === "working")
  useEffect(() => {
    if (!busy) return
    const id = setInterval(refreshProjects, 15_000)
    return () => clearInterval(id)
  }, [busy, refreshProjects])

  // Nothing runs without a subscription: a new person connects one first.
  if (AsyncResult.isSuccess(connectionsResult) && connections.length === 0) return <Redirect href="/connect" />

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 4,
          paddingHorizontal: gutter,
          paddingBottom: insets.bottom + 120
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 38 }}>
          <Orb need={needs} />
          <Text style={{ fontSize: 17, fontWeight: "700", letterSpacing: -0.34, color: color.t1, flex: 1 }}>Dream</Text>
          <IconButton icon="person" size={34} label="Settings" onPress={() => router.push("/settings")} />
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 8,
            marginBottom: 12
          }}
        >
          <Text style={{ fontSize: 30, fontWeight: "700", letterSpacing: -1.2, lineHeight: 33, color: color.t1 }}>
            {needs ? "Needs you" : AsyncResult.isSuccess(asksResult) ? "All clear" : ""}
          </Text>
          {needs || answered > 0 ? <Segments done={answered} remaining={asks.length} /> : null}
        </View>
        {unreachable ? (
          <Unreachable
            onRetry={() => {
              refreshProjects()
              refreshAsks()
            }}
          />
        ) : needs ? (
          <Deck asks={asks} onAnswered={() => setAnswered((n) => n + 1)} />
        ) : AsyncResult.isSuccess(projectsResult) || projects.length > 0 ? (
          <AllClear projects={projects} />
        ) : null}
        <ConnectionBanner connections={connections} />
        {projects.length > 0 ? (
          <Text style={{ fontSize: 13, fontWeight: "600", color: color.t3, marginBottom: 2 }}>Projects</Text>
        ) : null}
        {projects.map((summary, i) => (
          <ProjectRow key={summary.project.id} summary={summary} first={i === 0} asks={asks} />
        ))}
        <Usage connections={connections} />
      </ScrollView>
      {/* Keeps the clock readable over a long project list. */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: insets.top + 8,
          experimental_backgroundImage: `linear-gradient(to bottom, ${color.bg} 70%, rgba(10,10,12,0))`
        }}
      />
      <Dock />
    </View>
  )
}

function Unreachable(props: { readonly onRetry: () => void }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: color.line,
        borderRadius: 28,
        paddingTop: 22,
        paddingHorizontal: 22,
        paddingBottom: 16,
        backgroundColor: color.s1,
        marginBottom: 26
      }}
    >
      <Text style={{ fontSize: 20, fontWeight: "700", letterSpacing: -0.5, color: color.t1, marginBottom: 6 }}>
        Can’t reach Dream
      </Text>
      <Text style={{ fontSize: 15, lineHeight: 21.75, color: color.t2 }}>
        Your projects keep running. Check your connection and try again.
      </Text>
      <LinkButton title="Try again" onPress={props.onRetry} />
    </View>
  )
}

function AllClear(props: { readonly projects: ReadonlyArray<ProjectSummary> }) {
  const building = props.projects.filter((s) => s.project.phase === "building").map((s) => s.project.title)
  const live = props.projects.filter((s) => s.project.phase === "live").map((s) => s.project.title)
  // Name two at most; past that a count reads better than a paragraph of titles.
  const names = (list: ReadonlyArray<string>) =>
    list.length <= 1 ? (list[0] ?? "") : list.length === 2 ? `${list[0]} and ${list[1]}` : `${list.length} projects`
  const parts = [
    building.length > 0 ? `${names(building)} ${building.length > 1 ? "are" : "is"} building` : undefined,
    live.length > 0 ? `${names(live)} ${live.length > 1 ? "are" : "is"} running` : undefined
  ].filter(Boolean)
  const lead =
    props.projects.length === 0
      ? "Describe an idea below. I’ll look into it first, then write to you with questions."
      : `${parts.length > 0 ? `${parts.join(" and ")}. ` : ""}I’ll tap you the moment that changes.`
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: color.line,
        borderRadius: 28,
        paddingTop: 26,
        paddingHorizontal: 22,
        paddingBottom: 28,
        backgroundColor: color.s1,
        marginBottom: 26
      }}
    >
      <Text style={{ fontSize: 24, fontWeight: "700", letterSpacing: -0.72, color: color.t1, marginBottom: 6 }}>
        {props.projects.length === 0 ? "What should exist?" : "Nothing needs you."}
      </Text>
      <Text style={{ fontSize: 15, lineHeight: 21.75, color: color.t2 }}>{lead}</Text>
    </View>
  )
}

function ConnectionBanner(props: { readonly connections: ReadonlyArray<ModelConnection> }) {
  const router = useRouter()
  const broken = props.connections.find((c) => c.status === "expired" || c.status === "failed")
  if (!broken || props.connections.some((c) => c.status === "connected")) return null
  return (
    <Pressable
      onPress={() => router.push("/connect")}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 14,
        borderRadius: 20,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.needLine,
        marginBottom: 22
      }}
    >
      <Dot kind="need" />
      <Text style={{ flex: 1, fontSize: 15, color: color.t1 }}>
        Your {providerName(broken.provider)} sign-in {broken.status === "expired" ? "expired" : "stopped working"}.
        Projects are waiting.
      </Text>
      <Icon name="chev" size={15} color={color.t3} />
    </Pressable>
  )
}

function Progress(props: { readonly done: number; readonly total: number; readonly current: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 3 }}>
      {Array.from({ length: Math.min(props.total, 8) }, (_, i) => (
        <View
          key={i}
          style={{
            width: 13,
            height: 3,
            borderRadius: 2,
            backgroundColor: i < props.done ? color.t1 : "rgba(255,255,255,0.14)",
            experimental_backgroundImage:
              i === props.done && props.current
                ? "linear-gradient(90deg, #F5F5F7 50%, rgba(255,255,255,0.14) 50%)"
                : undefined
          }}
        />
      ))}
    </View>
  )
}

function ProjectRow(props: {
  readonly summary: ProjectSummary
  readonly first: boolean
  readonly asks: ReadonlyArray<OpenAsk>
}) {
  const router = useRouter()
  const { project, progress } = props.summary
  const open = props.asks.filter((ask) => ask.project.id === project.id).length
  // The Status card's now line, as plain text: markdown and any lines after the first don't fit here.
  const headline = project.headline ? plainText(project.headline).split("\n")[0] || undefined : undefined
  const now = useTickingNow(props.summary.activity?.state === "working")
  const presence = presenceOf({
    activity: props.summary.activity,
    working: false,
    pausedUntil: props.summary.pausedUntil,
    now
  })
  const line = homeLine(presence, {
    now,
    harness: project.harness,
    openAsks: open,
    headline
  })
  const sub = headline ?? phaseLabel(project.phase)
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: "/project/[id]", params: { id: project.id } })}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 13,
        borderTopWidth: props.first ? 0 : 1,
        borderColor: color.line,
        opacity: pressed ? 0.6 : 1
      })}
    >
      <PresenceTile icon={project.icon} dot={dotOf(presence)} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 17, fontWeight: "600", letterSpacing: -0.25, color: color.t1 }}>{project.title}</Text>
        {line ? (
          <StateLineText line={line} style={{ fontSize: 14, marginTop: 2 }} />
        ) : (
          <Text numberOfLines={1} style={{ fontSize: 14, color: color.t2, marginTop: 2 }}>
            {sub}
          </Text>
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {open > 0 ? (
          <Dot kind="need" />
        ) : project.phase === "live" ? (
          <Text style={{ fontSize: 13, color: color.t3 }}>Live</Text>
        ) : progress && progress.total > 0 && project.phase === "building" ? (
          <Progress done={progress.done} total={progress.total} current={project.phase === "building"} />
        ) : null}
      </View>
    </Pressable>
  )
}

function Usage(props: { readonly connections: ReadonlyArray<ModelConnection> }) {
  const usage = props.connections.find((c) => c.status === "connected" && c.usage)?.usage
  const line = usage ? usageLine(usage) : undefined
  if (!usage || !line) return null
  return (
    <View style={{ marginTop: 18, flexDirection: "row", alignItems: "center", gap: 10 }}>
      <View
        style={{ width: 44, height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.14)", overflow: "hidden" }}
      >
        <View style={{ width: `${Math.round(usageLeft(usage) * 100)}%`, height: 3, backgroundColor: color.t2 }} />
      </View>
      <Text style={{ fontSize: 13, color: color.t3 }}>{line}</Text>
    </View>
  )
}

function Dock() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        paddingTop: 34,
        paddingHorizontal: 16,
        paddingBottom: Math.max(insets.bottom, 12) + 2,
        experimental_backgroundImage: `linear-gradient(to top, ${color.bg} 58%, rgba(10,10,12,0))`
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Describe an idea"
        onPress={() => router.push("/new")}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          height: 56,
          paddingLeft: 20,
          paddingRight: 8,
          borderRadius: 28,
          backgroundColor: color.s2,
          borderWidth: 1,
          borderColor: color.line2,
          boxShadow: "0 10px 34px rgba(0,0,0,0.55)"
        }}
      >
        <Text style={{ flex: 1, fontSize: 16, color: color.t2 }}>Describe an idea…</Text>
        <IconButton icon="mic" tone="white" label="Dictate an idea" onPress={() => router.push("/new?dictate=1")} />
      </Pressable>
    </View>
  )
}
