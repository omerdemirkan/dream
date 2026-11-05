/**
 * The Status tab: the live roadmap the agent keeps with `dream status`.
 * What it's doing now, what it just did, what's next, and what it needs from
 * them, pinned to the milestone where it matters.
 */
import type { AccessMessage, AskMessage, Message, MessageId, Milestone, Need, StatusCard } from "@dream/domain"
import { isOpenAsk } from "@dream/domain"
import { DateTime } from "effect"
import { useEffect, useRef } from "react"
import { type HostInstance, Linking, Pressable, Text, View } from "react-native"
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from "react-native-reanimated"
import Svg, { Circle, Text as SvgText } from "react-native-svg"
import { dayOfPhase, milestoneDate, phaseLabel, shortDuration, timeLabel } from "../data/format.ts"
import type { ProjectState } from "../data/projectState.ts"
import { accessLabel, accessScope } from "./describe.ts"
import { useNow, useOpenMessage } from "./hooks.ts"
import { Dot, Icon, Lab } from "./kit.tsx"
import { MediaStrip } from "./Media.tsx"
import { color, gutter } from "./theme.ts"

// ---------------------------------------------------------------------------
// The status line under the description
// ---------------------------------------------------------------------------

const openAsksOf = (messages: ReadonlyArray<Message>) =>
  messages.filter((m): m is AskMessage => isOpenAsk(m) && !(m._tag === "Access" && m.when))

export function StatusLine(props: { readonly state: ProjectState }) {
  const { status, working } = props.state
  const now = useNow()
  const asks = openAsksOf(props.state.messages)
  const phase = status.phase
  let dot: "need" | "live" | "quiet" = "quiet"
  let detail: string | undefined
  if (status.pausedUntil && DateTime.isGreaterThan(status.pausedUntil, now)) {
    return <Line dot="quiet" lead="Paused" detail={`back at ${timeLabel(status.pausedUntil)}`} />
  }
  if (phase === "new") return <Line dot="quiet" lead="Looking into this" />
  if (asks.length > 0) {
    dot = "need"
    detail = phase === "interviewing" ? `${asks.length} question${asks.length > 1 ? "s" : ""} for you` : "needs you"
  } else if (phase === "live") {
    dot = "live"
    detail = "maintained · needs nothing from you"
  } else if (phase === "building") {
    dot = working ? "live" : "quiet"
    detail = `${dayOfPhase(status.phaseSince, now)} · nothing needed from you`
  } else if (phase === "interviewing") {
    detail = "thanks, working on it"
  } else {
    dot = working ? "live" : "quiet"
    detail = working ? "working on it" : "reading your reactions"
  }
  return <Line dot={dot} lead={phaseLabel(phase)} detail={detail} />
}

function Line(props: {
  readonly dot: "need" | "live" | "quiet"
  readonly lead: string
  readonly detail?: string | undefined
}) {
  return (
    <View style={{ marginTop: 14, flexDirection: "row", alignItems: "center", gap: 9 }}>
      <Dot kind={props.dot} />
      <Text style={{ fontSize: 14, color: color.t2, flex: 1 }}>
        <Text style={{ color: color.t1, fontWeight: "600" }}>{props.lead}</Text>
        {props.detail ? ` · ${props.detail}` : ""}
      </Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Pieces of the current milestone
// ---------------------------------------------------------------------------

function Block(props: {
  readonly label: string
  readonly text: string
  readonly hero?: boolean
  readonly live?: boolean
}) {
  return (
    <View style={{ marginTop: 16 }}>
      <Lab>{props.label}</Lab>
      <Text
        style={
          props.hero
            ? { marginTop: 5, fontSize: 19, lineHeight: 25, fontWeight: "600", letterSpacing: -0.38, color: color.t1 }
            : { marginTop: 5, fontSize: 16, lineHeight: 23, letterSpacing: -0.08, color: color.t1 }
        }
      >
        {props.text}
      </Text>
      {props.live ? <LiveBar /> : null}
    </View>
  )
}

/** `.livebar`: a light sweeping along a hairline while the agent works. */
function LiveBar() {
  const x = useSharedValue(0)
  useEffect(() => {
    x.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.ease) }), -1)
    return () => cancelAnimation(x)
  }, [x])
  const style = useAnimatedStyle(() => ({ left: `${-40 + x.value * 144}%` }))
  return (
    <View
      style={{
        marginTop: 12,
        height: 2,
        borderRadius: 1,
        backgroundColor: "rgba(255,255,255,0.1)",
        overflow: "hidden"
      }}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 0,
            bottom: 0,
            width: "36%",
            experimental_backgroundImage: "linear-gradient(90deg, transparent, #F5F5F7, transparent)"
          },
          style
        ]}
      />
    </View>
  )
}

function PauseCard(props: { readonly until: DateTime.Utc; readonly since: DateTime.Utc }) {
  const now = useNow()
  const total = Math.max(1, DateTime.toEpochMillis(props.until) - DateTime.toEpochMillis(props.since))
  const left = Math.max(0, DateTime.toEpochMillis(props.until) - DateTime.toEpochMillis(now))
  const circumference = 2 * Math.PI * 19
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 14,
        alignItems: "center",
        marginTop: 14,
        padding: 14,
        borderRadius: 18,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.line
      }}
    >
      <Svg width={46} height={46} viewBox="0 0 46 46">
        <Circle cx={23} cy={23} r={19} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={3} />
        <Circle
          cx={23}
          cy={23}
          r={19}
          fill="none"
          stroke={color.t1}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={`${circumference}`}
          strokeDashoffset={circumference * (1 - left / total)}
          transform="rotate(-90 23 23)"
        />
        <SvgText x={23} y={27} textAnchor="middle" fontSize={11} fontWeight="600" fill={color.t1}>
          {shortDuration(now, props.until)}
        </SvgText>
      </Svg>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 17, fontWeight: "700", letterSpacing: -0.34, color: color.t1 }}>
          Paused until {timeLabel(props.until)}
        </Text>
        <Text style={{ fontSize: 14, lineHeight: 20, color: color.t2, marginTop: 3 }}>
          Your usage resets then. I’ll pick up automatically.
        </Text>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Needs: open asks (amber, "in Chat"), later needs (dashed), resolved ones
// ---------------------------------------------------------------------------

function NeedRow(props: { readonly message: AskMessage }) {
  const ref = useRef<HostInstance>(null)
  const open = useOpenMessage()
  const m = props.message
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      onPress={() => open({ projectId: m.projectId, messageId: m.id, message: m, from: ref })}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 14,
        paddingLeft: 16,
        paddingRight: 14,
        borderRadius: 20,
        backgroundColor: pressed ? color.s2 : color.s1,
        borderWidth: 1,
        borderColor: color.needLine
      })}
    >
      <Dot kind="need" />
      <View style={{ flex: 1 }}>
        <Text
          style={{ fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: color.need }}
        >
          {m._tag === "Access" ? "Access" : "Question"} · in Chat
        </Text>
        <Text
          style={{
            fontSize: 15.5,
            lineHeight: 20,
            fontWeight: "600",
            letterSpacing: -0.15,
            color: color.t1,
            marginTop: 3
          }}
        >
          {m._tag === "Access" ? m.why : m.question}
        </Text>
      </View>
      <Icon name="chev" size={15} color={color.t3} />
    </Pressable>
  )
}

function LaterRow(props: {
  readonly title: string
  readonly subtitle: string
  readonly done: boolean
  readonly message: AskMessage | undefined
}) {
  const ref = useRef<HostInstance>(null)
  const open = useOpenMessage()
  const m = props.message
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      disabled={!m}
      onPress={() => m && open({ projectId: m.projectId, messageId: m.id, message: m, from: ref })}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginTop: 12,
        paddingVertical: 12,
        paddingLeft: 14,
        paddingRight: 12,
        borderRadius: 16,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: color.line2,
        backgroundColor: pressed ? color.s1 : "rgba(255,255,255,0.025)"
      })}
    >
      <Icon name={props.done ? "check" : "clock"} size={19} color={color.t2} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", letterSpacing: -0.15, color: color.t1 }}>{props.title}</Text>
        <Text style={{ fontSize: 13, color: color.t2, marginTop: 1 }}>{props.subtitle}</Text>
      </View>
      {m ? <Icon name="chev" size={15} color={color.t3} /> : null}
    </Pressable>
  )
}

function NeedView(props: { readonly need: Need; readonly messages: ReadonlyMap<MessageId, Message> }) {
  const { need } = props
  const linked = need.messageId ? props.messages.get(need.messageId) : undefined
  const message = linked && linked._tag !== "Text" ? linked : undefined
  if (message && isOpenAsk(message) && !(message._tag === "Access" && message.when) && !need.when) {
    return (
      <View style={{ marginTop: 10 }}>
        <NeedRow message={message} />
      </View>
    )
  }
  const resolved =
    message?._tag === "Access"
      ? message.state._tag === "Connected"
      : message?._tag === "Question"
        ? message.state._tag === "Answered"
        : false
  const subtitle = resolved
    ? message?._tag === "Access"
      ? "Saved to the vault"
      : "Answered"
    : need.when
      ? `Needed here · ${need.when}`
      : message?._tag === "Access" && message.when
        ? `Needed here · ${message.when}`
        : "Needed here"
  return <LaterRow title={need.what} subtitle={subtitle} done={resolved} message={message} />
}

// ---------------------------------------------------------------------------
// The roadmap
// ---------------------------------------------------------------------------

/** The milestone that carries now / just did / media / next: the current one, else the latest done. */
const focusIndex = (milestones: ReadonlyArray<Milestone>) => {
  const current = milestones.findIndex((m) => m.state === "current")
  if (current !== -1) return current
  let best = -1
  milestones.forEach((m, i) => {
    if (m.state !== "done") return
    const prev = milestones[best]
    if (best === -1 || (m.date && prev?.date && DateTime.isGreaterThan(m.date, prev.date)) || (m.date && !prev?.date))
      best = i
  })
  return best
}

function Node(props: { readonly state: Milestone["state"]; readonly paused: boolean }) {
  const pulse = useSharedValue(0)
  const isNow = props.state === "current" && !props.paused
  useEffect(() => {
    if (!isNow) return
    pulse.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.out(Easing.ease) }), -1)
    return () => cancelAnimation(pulse)
  }, [isNow, pulse])
  const ring = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * 0.9 }],
    opacity: 0.32 * (1 - pulse.value)
  }))
  const base = { position: "absolute" as const, left: 0, top: 2, width: 24, height: 24, borderRadius: 12 }
  if (props.state === "done") {
    return (
      <View style={[base, { backgroundColor: color.t1, alignItems: "center", justifyContent: "center" }]}>
        <Icon name="check" size={12} color={color.black} weight="bold" />
      </View>
    )
  }
  if (props.state === "current") {
    return (
      <View
        style={[
          base,
          {
            borderWidth: 2,
            borderColor: props.paused ? color.t2 : color.t1,
            alignItems: "center",
            justifyContent: "center"
          }
        ]}
      >
        {isNow ? (
          <>
            <Animated.View
              style={[
                { position: "absolute", width: 24, height: 24, borderRadius: 12, backgroundColor: color.white },
                ring
              ]}
            />
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color.t1 }} />
          </>
        ) : (
          <Icon name="pause" size={10} color={color.t2} />
        )}
      </View>
    )
  }
  return <View style={[base, { borderWidth: 1.5, borderStyle: "dashed", borderColor: "rgba(255,255,255,0.3)" }]} />
}

function Connector(props: { readonly state: Milestone["state"] }) {
  const style =
    props.state === "upcoming"
      ? { borderLeftWidth: 2, borderStyle: "dashed" as const, borderColor: "rgba(255,255,255,0.2)" }
      : props.state === "current"
        ? {
            experimental_backgroundImage:
              "linear-gradient(#F5F5F7 0px, rgba(255,255,255,0.5) 40px, rgba(255,255,255,0.14) 160px)",
            width: 2
          }
        : { backgroundColor: "rgba(255,255,255,0.5)", width: 2 }
  return <View style={[{ position: "absolute", left: 11, top: 30, bottom: 2, borderRadius: 1 }, style]} />
}

function MilestoneView(props: {
  readonly milestone: Milestone
  readonly last: boolean
  readonly focus: boolean
  readonly far: boolean
  readonly card: StatusCard
  readonly working: boolean
  readonly messages: ReadonlyMap<MessageId, Message>
  readonly unpinned: ReadonlyArray<AskMessage>
}) {
  const { milestone: m, card } = props
  const now = useNow()
  const paused = card.pausedUntil !== undefined && DateTime.isGreaterThan(card.pausedUntil, now)
  const isCurrent = m.state === "current"
  const doneFocus = props.focus && m.state === "done"
  const titleStyle = isCurrent
    ? { fontSize: 22, lineHeight: 28, fontWeight: "700" as const, letterSpacing: -0.66, color: color.t1 }
    : m.state === "done"
      ? {
          fontSize: 17,
          lineHeight: 28,
          fontWeight: (doneFocus || m.detail ? "600" : "500") as "600" | "500",
          letterSpacing: -0.25,
          color: doneFocus || m.detail ? color.t1 : color.t2
        }
      : {
          fontSize: 17,
          lineHeight: 28,
          fontWeight: "600" as const,
          letterSpacing: -0.25,
          color: props.far ? color.t3 : color.t2
        }
  const when = m.date ? milestoneDate(m.date, now) : undefined
  return (
    <View style={{ paddingLeft: 44, paddingBottom: props.last ? 4 : 22 }}>
      {props.last ? null : <Connector state={m.state} />}
      <Node state={m.state} paused={paused} />
      <Text style={titleStyle}>
        {m.title}
        {m.state === "done" && when ? (
          <Text style={{ fontSize: 13, color: color.t3, fontWeight: "400" }}>{`  ${when}`}</Text>
        ) : null}
      </Text>
      {m.state !== "done" && when ? <Text style={{ fontSize: 14, color: color.t3, marginTop: -2 }}>{when}</Text> : null}
      {m.detail ? (
        <Text style={{ fontSize: m.state === "done" ? 15 : 14, lineHeight: 21, color: color.t2, marginTop: 2 }}>
          {m.detail}
        </Text>
      ) : null}
      {props.focus ? <FocusBlocks card={card} working={props.working} paused={paused} current={isCurrent} /> : null}
      {m.needs.map((need, i) => (
        <NeedView key={`${need.what}-${i}`} need={need} messages={props.messages} />
      ))}
      {props.focus
        ? props.unpinned.map((message) => (
            <View key={message.id} style={{ marginTop: 10 }}>
              <NeedRow message={message} />
            </View>
          ))
        : null}
    </View>
  )
}

function FocusBlocks(props: {
  readonly card: StatusCard
  readonly working: boolean
  readonly paused: boolean
  readonly current: boolean
}) {
  const { card } = props
  return (
    <>
      {props.paused && card.pausedUntil ? <PauseCard until={card.pausedUntil} since={card.updatedAt} /> : null}
      {card.now ? (
        <Block
          label={props.paused ? "Was doing" : "Now"}
          text={card.now}
          hero={!props.paused}
          live={props.working && !props.paused}
        />
      ) : null}
      {card.justDid && props.current ? <Block label="Just did" text={card.justDid} /> : null}
      <MediaStrip media={card.media} inset={44} />
      {card.next && props.current ? <Block label="Next" text={card.next} /> : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

const earlyNote = (phase: StatusCard["phase"]) =>
  phase === "new"
    ? "I’m looking into this before I ask you anything. That can take a few minutes, so there’s no need to wait around — I’ll send a notification when I have a question."
    : "Thanks. I’m shaping the first version around your answer, and I’ll write when there’s something to look at."

export function StatusTab(props: { readonly state: ProjectState }) {
  const { project, status, messages, working } = props.state
  const byId = new Map(messages.map((m) => [m.id, m] as const))
  const pinned = new Set(status.milestones.flatMap((m) => m.needs.flatMap((n) => (n.messageId ? [n.messageId] : []))))
  const unpinned = openAsksOf(messages).filter((m) => !pinned.has(m.id))
  const focus = focusIndex(status.milestones)
  const firstUpcoming = status.milestones.findIndex((m) => m.state === "upcoming")
  const connected = messages.filter((m): m is AccessMessage => m._tag === "Access" && m.state._tag === "Connected")
  return (
    <View>
      <Text style={{ marginTop: 2, fontSize: 16, lineHeight: 23, color: color.t2 }}>{project.idea}</Text>
      <StatusLine state={props.state} />
      {status.milestones.length === 0 ? (
        <View>
          {status.now ? <Block label="Now" text={status.now} hero live={working} /> : null}
          {status.justDid ? <Block label="Just did" text={status.justDid} /> : null}
          <MediaStrip media={status.media} inset={gutter} />
          {status.next ? <Block label="Next" text={status.next} /> : null}
          {unpinned.length > 0 ? (
            <View style={{ marginTop: 24, gap: 10 }}>
              {unpinned.map((message) => (
                <NeedRow key={message.id} message={message} />
              ))}
            </View>
          ) : status.now ? null : (
            <Text style={{ marginTop: 26, fontSize: 15, lineHeight: 22, color: color.t2, maxWidth: 330 }}>
              {earlyNote(status.phase)}
            </Text>
          )}
        </View>
      ) : (
        <View style={{ marginTop: 26 }}>
          {focus === -1 && unpinned.length > 0 ? (
            <View style={{ gap: 10, marginBottom: 22 }}>
              {unpinned.map((message) => (
                <NeedRow key={message.id} message={message} />
              ))}
            </View>
          ) : null}
          {status.milestones.map((milestone, i) => (
            <MilestoneView
              key={`${milestone.title}-${i}`}
              milestone={milestone}
              last={i === status.milestones.length - 1}
              focus={i === focus}
              far={firstUpcoming !== -1 && i > firstUpcoming && milestone.state === "upcoming"}
              card={status}
              working={working}
              messages={byId}
              unpinned={i === focus ? unpinned : []}
            />
          ))}
        </View>
      )}
      <Meta connected={connected} project={props.state.project} />
    </View>
  )
}

function Meta(props: { readonly connected: ReadonlyArray<AccessMessage>; readonly project: ProjectState["project"] }) {
  const open = useOpenMessage()
  const published = props.project.publishedPort !== undefined
  if (props.connected.length === 0 && !published) return null
  const host = props.project.publicUrl.replace(/^https?:\/\//, "")
  return (
    <View style={{ marginTop: 30, borderTopWidth: 1, borderColor: color.line, paddingTop: 6 }}>
      {published ? (
        <MetaRow
          icon="safari"
          title="Open in Safari"
          subtitle={host}
          onPress={() => void Linking.openURL(props.project.publicUrl)}
          trailing="arrowOut"
        />
      ) : null}
      {props.connected.map((message, i) => (
        <MetaRow
          key={message.id}
          icon="lock"
          title={accessLabel(message.request)}
          subtitle={`${accessScope(message.request) ? `${accessScope(message.request)} ` : ""}Shared by all your projects`}
          onPress={() => open({ projectId: message.projectId, messageId: message.id, message })}
          trailing="chev"
          divider={published || i > 0}
        />
      ))}
    </View>
  )
}

function MetaRow(props: {
  readonly icon: "lock" | "safari"
  readonly title: string
  readonly subtitle: string
  readonly onPress: () => void
  readonly trailing: "chev" | "arrowOut"
  readonly divider?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 12,
        borderTopWidth: props.divider ? 1 : 0,
        borderColor: color.line,
        opacity: pressed ? 0.6 : 1
      })}
    >
      <Icon name={props.icon} size={19} color={color.t2} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: color.t1 }}>{props.title}</Text>
        <Text numberOfLines={1} style={{ fontSize: 13, color: color.t2, marginTop: 2 }}>
          {props.subtitle}
        </Text>
      </View>
      <Icon name={props.trailing} size={15} color={color.t3} />
    </Pressable>
  )
}
