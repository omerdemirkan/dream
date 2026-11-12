/**
 * A project's usage sheet, direction A ("Index": mocks/screens/usage-sheet-directions). The header's ring opens it
 * over the project. It shows the week as a ring with this project's share in it and one line on where the project
 * stands, then one row each for what they can look into or change, laid out like Settings: Limits, Agent, Plan (with
 * both plans connected, or a move to speak of) and what Dream paid. Each row opens a page of its own in the sheet,
 * with one purpose: the two limits; the model and effort; the plans and the move between them; the lines Dream paid
 * for. When something needs them, the line by the ring and the row it concerns turn amber. What it says comes from
 * `data/usage.ts`, `data/costs.ts`, `data/advanced.ts`, `data/planSwitch.ts` and `data/settings.ts`.
 */
import type { ModelConnection, Project, ProjectId, ProjectUsage } from "@dream/domain"
import { providerOf } from "@dream/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import * as Haptics from "expo-haptics"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import Animated, { Easing, FadeIn, SlideInDown, SlideInLeft, SlideInRight } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { agentModelName, modelRows } from "../data/advanced.ts"
import { type ProjectCostsPage, projectCostsPage } from "../data/costs.ts"
import { providerName } from "../data/format.ts"
import { connectedPlans } from "../data/plans.ts"
import { confirmMove, moveAction, type PlanAction, planNotice } from "../data/planSwitch.ts"
import { planRow } from "../data/settings.ts"
import { limitsView, type UsageIndex, usageIndex, withLimit } from "../data/usage.ts"
import { modelConnectionsAtom, projectCostsAtom, projectUsageAtom, setUsageLimitsFn } from "../state/atoms.ts"
import { useAction } from "./actions.ts"
import { AgentPicker, useAgentChoice, usePlanMove } from "./Advanced.tsx"
import { CostRow, costsFootnote, Total } from "./Costs.tsx"
import { ActionRow, Group, GroupRow, PlanMark, RowTile, SectionLabel } from "./Group.tsx"
import { useNow } from "./hooks.ts"
import { Button, Icon, IconButton, SymbolIcon } from "./kit.tsx"
import { color, gutter, tracking } from "./theme.ts"
import { Footnote, LimitField, SectionHeading, UsageRing } from "./Usage.tsx"

/** What the sheet needs of the project: its agent, its plan, and a move under way. */
export type SheetProject = Pick<Project, "id" | "harness" | "agentModel" | "agentEffort" | "planSwitch">

/** The sheet's pages: the index, and one page per row. */
export type UsagePage = "index" | "limits" | "agent" | "plan" | "dream"

/** Where the sheet opens: one of its pages, or the Plan page asking at once whether to move to their other plan. */
export type UsageSheetStart = UsagePage | "move"

const ease = Easing.bezier(0.2, 0.8, 0.2, 1)

const pageTitle: Record<Exclude<UsagePage, "index">, string> = {
  limits: "Limits",
  agent: "Agent",
  plan: "Plan",
  dream: "Dream usage"
}

/** Opens over the project, below its header. Fetches fresh each time it opens. */
export function UsageSheet(props: {
  readonly projectId: ProjectId
  readonly title: string
  readonly project: SheetProject | undefined
  readonly open: boolean
  readonly start?: UsageSheetStart
  readonly onClose: () => void
}) {
  const close = () => {
    Keyboard.dismiss()
    props.onClose()
  }
  return (
    <Modal visible={props.open} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View style={{ flex: 1 }}>
        <Pressable
          accessibilityLabel="Close"
          onPress={close}
          style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.58)" }]}
        />
        {props.open ? (
          <Sheet
            projectId={props.projectId}
            title={props.title}
            project={props.project}
            start={props.start ?? "index"}
            onClose={close}
          />
        ) : null}
      </View>
    </Modal>
  )
}

/** The sheet itself, made each time it opens, at the page `start` says. */
function Sheet(props: {
  readonly projectId: ProjectId
  readonly title: string
  readonly project: SheetProject | undefined
  readonly start: UsageSheetStart
  readonly onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  const [page, setPage] = useState<UsagePage>(props.start === "move" ? "plan" : props.start)
  const [back, setBack] = useState(false)
  // Asked once, as the sheet opens; coming back to the Plan page later doesn't ask again.
  const [askToMove, setAskToMove] = useState(props.start === "move")
  const open = (next: UsagePage) => {
    setBack(false)
    setPage(next)
  }
  const goBack = () => {
    Keyboard.dismiss()
    setAskToMove(false)
    setBack(true)
    setPage("index")
  }

  const usageResult = useAtomValue(projectUsageAtom(props.projectId))
  // The family keeps the last fetch, so opening the sheet fetches again, and shows the spinner rather than the
  // figures from the last time it was open.
  const refreshUsage = useAtomRefresh(projectUsageAtom(props.projectId))
  useEffect(() => refreshUsage(), [refreshUsage])
  // What saving a limit returned, newer than the fetch.
  const [saved, setSaved] = useState<ProjectUsage | undefined>(undefined)
  const fetched = usageResult.waiting ? undefined : Option.getOrUndefined(AsyncResult.value(usageResult))
  const usage = saved ?? fetched

  const costsResult = useAtomValue(projectCostsAtom(props.projectId))
  const refreshCosts = useAtomRefresh(projectCostsAtom(props.projectId))
  useEffect(() => refreshCosts(), [refreshCosts])
  const costs = costsResult.waiting ? undefined : Option.getOrUndefined(AsyncResult.value(costsResult))
  const costsPage = costs ? projectCostsPage(costs) : undefined

  const connections = Option.getOrUndefined(AsyncResult.value(useAtomValue(modelConnectionsAtom))) ?? []
  const now = useNow(30_000)
  const index = usage && props.project ? usageIndex(usage, props.project, connections, now) : undefined

  const loading = (failed: boolean) =>
    failed ? (
      <Text style={{ fontSize: 14.5, color: color.t2, marginTop: 24 }}>Usage isn’t available right now.</Text>
    ) : (
      <ActivityIndicator color={color.t3} style={{ marginTop: 40 }} />
    )
  const usageFailed = usage === undefined && AsyncResult.isFailure(usageResult)

  const body = (): ReactNode => {
    switch (page) {
      case "index":
        return usage && index && props.project ? (
          <IndexPage index={index} project={props.project} costsPage={costsPage} onOpen={open} />
        ) : (
          loading(usageFailed)
        )
      case "limits":
        return usage && index ? (
          <LimitsPage projectId={props.projectId} usage={usage} index={index} onSaved={setSaved} />
        ) : (
          loading(usageFailed)
        )
      case "agent":
        return props.project ? <AgentPage project={props.project} /> : loading(false)
      case "plan":
        return props.project ? (
          <PlanPage
            projectId={props.projectId}
            project={props.project}
            connections={connections}
            askToMove={askToMove}
          />
        ) : (
          loading(false)
        )
      case "dream":
        return costsPage ? <DreamPage page={costsPage} /> : loading(AsyncResult.isFailure(costsResult))
    }
  }

  return (
    <Animated.View
      entering={SlideInDown.duration(340).easing(ease)}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        top: insets.top + 50,
        backgroundColor: color.s1,
        borderTopLeftRadius: 30,
        borderTopRightRadius: 30,
        borderCurve: "continuous",
        borderWidth: 1,
        borderBottomWidth: 0,
        borderColor: color.line2,
        overflow: "hidden"
      }}
    >
      <View
        style={{
          alignSelf: "center",
          width: 36,
          height: 5,
          borderRadius: 3,
          backgroundColor: "rgba(255,255,255,0.22)",
          marginTop: 10,
          marginBottom: 14
        }}
      />
      <View style={{ paddingHorizontal: gutter }}>
        {page === "index" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 20, fontWeight: "700", letterSpacing: tracking(-0.035, 20), color: color.t1 }}>
                Usage
              </Text>
              <Text numberOfLines={1} style={{ fontSize: 13.5, color: color.t3, marginTop: 1 }}>
                {props.title}
              </Text>
            </View>
            <IconButton icon="close" size={32} tone="quiet" label="Close" onPress={props.onClose} />
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <IconButton icon="back" size={32} tone="quiet" label="Usage" onPress={goBack} />
            <Text
              accessibilityRole="header"
              style={{
                flex: 1,
                textAlign: "center",
                fontSize: 17,
                fontWeight: "600",
                letterSpacing: tracking(-0.02, 17),
                color: color.t1
              }}
            >
              {pageTitle[page]}
            </Text>
            <IconButton icon="close" size={32} tone="quiet" label="Close" onPress={props.onClose} />
          </View>
        )}
      </View>
      <Animated.View
        key={page}
        entering={(page === "index" ? (back ? SlideInLeft : FadeIn) : SlideInRight).duration(260).easing(ease)}
        style={{ flex: 1 }}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: gutter,
            paddingTop: 4,
            paddingBottom: Math.max(insets.bottom, 16) + 12
          }}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {body()}
        </ScrollView>
      </Animated.View>
    </Animated.View>
  )
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

function IndexPage(props: {
  readonly index: UsageIndex
  readonly project: SheetProject
  readonly costsPage: ProjectCostsPage | undefined
  readonly onOpen: (page: UsagePage) => void
}) {
  const { index, project } = props
  const tile = (glyph: ReactNode) => <RowTile>{glyph}</RowTile>
  return (
    <>
      {index.ring ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 20, marginTop: 12 }}>
          <View style={{ width: 118, height: 118 }}>
            <UsageRing
              size={118}
              stroke={14}
              arcs={index.ring.arcs}
              focusColor={index.ring.need ? color.need : color.t1}
            />
            <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
              <Text
                style={{
                  fontSize: 28,
                  lineHeight: 30,
                  fontWeight: "700",
                  letterSpacing: tracking(-0.04, 28),
                  color: color.t1,
                  fontVariant: ["tabular-nums"]
                }}
              >
                {index.ring.label}
              </Text>
              <Text style={{ fontSize: 12, color: color.t3, marginTop: 3 }}>of your week</Text>
            </View>
          </View>
          <Lead index={index} />
        </View>
      ) : (
        <View style={{ marginTop: 12 }}>
          <Lead index={index} />
        </View>
      )}
      <SectionLabel>This project</SectionLabel>
      <Group raised need={index.limits.need || index.plan?.need === true}>
        <GroupRow
          icon={tile(<SymbolIcon name="gauge.with.dots.needle.33percent" size={16} color={color.t2} />)}
          title="Limits"
          value={index.limits.value}
          need={index.limits.need}
          onPress={() => props.onOpen("limits")}
        />
        <GroupRow
          icon={tile(<Icon name="spark" size={15} color={color.t2} />)}
          title="Agent"
          value={agentModelName(project)}
          onPress={() => props.onOpen("agent")}
        />
        {index.plan ? (
          <GroupRow
            icon={<PlanMark provider={providerOf(project.harness)} />}
            title="Plan"
            subtitle={index.plan.note}
            value={
              <>
                <Text
                  numberOfLines={1}
                  style={{ fontSize: 15, color: index.plan.need ? color.need : color.t2, flexShrink: 1 }}
                >
                  {index.plan.value}
                </Text>
                {index.plan.busy ? <ActivityIndicator size="small" color={color.t3} /> : null}
              </>
            }
            accessibilityLabel={`Plan, ${index.plan.value}`}
            onPress={() => props.onOpen("plan")}
          />
        ) : null}
      </Group>
      {props.costsPage ? (
        <>
          <SectionLabel>Dream usage</SectionLabel>
          <Group raised>
            <GroupRow
              icon={tile(<Icon name="cpu" size={16} color={color.t2} />)}
              title={props.costsPage.title}
              value={props.costsPage.total}
              strong
              accessibilityHint="Shows what Dream paid for"
              onPress={() => props.onOpen("dream")}
            />
          </Group>
        </>
      ) : null}
    </>
  )
}

/** The line beside the ring: where the project stands, in amber when something holds it back. */
function Lead(props: { readonly index: UsageIndex }) {
  const { lead, detail } = props.index
  const ring = props.index.ring !== undefined
  return (
    <View style={{ flex: 1 }}>
      <Text
        style={
          ring
            ? {
                fontSize: 17,
                lineHeight: 22,
                fontWeight: "600",
                letterSpacing: tracking(-0.02, 17),
                color: lead.need ? color.need : color.t1
              }
            : { fontSize: 16, lineHeight: 23, color: color.t2 }
        }
      >
        {lead.text}
      </Text>
      {detail ? <Text style={{ fontSize: 14, lineHeight: 19.6, color: color.t3, marginTop: 4 }}>{detail}</Text> : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

function LimitsPage(props: {
  readonly projectId: ProjectId
  readonly usage: ProjectUsage
  readonly index: UsageIndex
  readonly onSaved: (usage: ProjectUsage) => void
}) {
  const { usage, index } = props
  const save = useAction(setUsageLimitsFn)
  const limits = usage.limits ?? {}
  const view = limitsView(usage)
  const reached = usage.limitReached
  const change = (which: "project" | "planLeft", value: number | undefined) => {
    const next = withLimit(limits, which, value)
    if (next.projectWeekPercent === limits.projectWeekPercent && next.planLeftPercent === limits.planLeftPercent) return
    save.run({ projectId: props.projectId, limits: next }, { onSuccess: props.onSaved })
  }
  const week = usage.weekWindow ?? usage.weekly
  return (
    <>
      <Text
        style={{ fontSize: 15, lineHeight: 21, color: reached ? color.t1 : color.t2, marginTop: 14, marginBottom: 6 }}
      >
        {reached ? (
          <>
            <Text style={{ color: color.need, fontWeight: "600" }}>{index.lead.text}</Text> {index.detail}
          </>
        ) : (
          "Off, the project uses what it needs and pauses only when your plan runs out. Either limit pauses it sooner."
        )}
      </Text>
      <LimitField
        before="This project may use up to"
        after="of the week"
        label="Most of the week this project may use, in percent"
        row={view.project}
        help="It pauses there, and picks up when the week resets."
        onChange={(value) => change("project", value)}
      />
      <LimitField
        before="Stop when the plan has"
        after="left"
        label="Pause when this much of the plan is left, in percent"
        row={view.planLeft}
        help="Keeps the rest of your week for your other projects and your own chats."
        onChange={(value) => change("planLeft", value)}
      />
      {reached ? (
        <Button
          title="Clear the limit"
          variant="ghost"
          busy={save.busy}
          onPress={() => {
            void Haptics.selectionAsync()
            change(reached.limit, undefined)
          }}
          style={{ marginTop: 20 }}
        />
      ) : null}
      {week ? (
        <Footnote>
          {`This project has used ${week.projectPercent < 0.5 ? "under 1%" : `about ${Math.round(week.projectPercent)}%`} of the week so far. Shares are estimates.`}
        </Footnote>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

function AgentPage(props: { readonly project: SheetProject }) {
  const agent = useAgentChoice(props.project)
  return (
    <>
      <SectionHeading>Model</SectionHeading>
      <AgentPicker
        heading={false}
        models={modelRows(props.project.harness, agent.model)}
        effort={agent.effort}
        onModel={(model) => agent.change({ model, effort: agent.effort })}
        onEffort={(effort) => agent.change({ model: agent.model, effort })}
      />
      <Footnote>
        {agent.changed
          ? "It switches at its next turn, in the same conversation."
          : "A change takes effect at its next turn, in the same conversation. The agent picks its helpers’ models itself."}
      </Footnote>
    </>
  )
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * The plans they have, with what's left of each, and the move: to the other plan (asking first), staying while a
 * move waits, or trying again after one didn't work.
 */
function PlanPage(props: {
  readonly projectId: ProjectId
  readonly project: SheetProject
  readonly connections: ReadonlyArray<ModelConnection>
  readonly askToMove: boolean
}) {
  const now = useNow(60_000)
  const move = usePlanMove(props.projectId)
  const plans = connectedPlans(props.connections)
  const current = providerOf(props.project.harness)
  const waiting = props.project.planSwitch?.state === "waiting"
  const notice = planNotice(props.project, plans, now)
  const other = plans.find((p) => p !== current)
  // `?sheet=plan`: ask at once, once the page has slid in.
  const asked = useRef(false)
  useEffect(() => {
    if (!props.askToMove || asked.current || other === undefined || waiting) return
    const timer = setTimeout(() => {
      asked.current = true
      move.go(moveAction(other))
    }, 500)
    return () => clearTimeout(timer)
  }, [props.askToMove, other, waiting])
  const action: PlanAction | undefined =
    notice?.action ?? (other === undefined || waiting ? undefined : moveAction(other))
  const connected = plans.flatMap((provider) => {
    const connection = props.connections.find((c) => c.provider === provider && c.status === "connected")
    return connection ? [connection] : []
  })
  return (
    <>
      <Text style={{ fontSize: 15, lineHeight: 21, color: color.t2, marginTop: 14 }}>
        {notice?.text ??
          `It runs on your ${providerName(current)} plan.${other ? ` Your ${providerName(other)} plan is connected too.` : ""}`}
      </Text>
      {connected.length > 0 ? (
        <Group raised style={{ marginTop: 16 }}>
          {connected.map((connection) => {
            const row = planRow(connection, undefined, now)
            const on = connection.provider === current
            return (
              <GroupRow
                key={connection.provider}
                icon={<PlanMark provider={connection.provider} />}
                title={row.title}
                value={
                  <>
                    <Text
                      numberOfLines={1}
                      style={{
                        fontSize: 15,
                        color: row.need ? color.need : color.t2,
                        fontVariant: ["tabular-nums"],
                        flexShrink: 1
                      }}
                    >
                      {row.value}
                    </Text>
                    {on ? <Icon name="check" size={15} color={color.t1} weight="semibold" /> : null}
                  </>
                }
                accessibilityLabel={`${row.title}, ${row.value}${on ? ", the plan it runs on" : ""}`}
              />
            )
          })}
        </Group>
      ) : null}
      {action ? (
        <Group raised style={{ marginTop: 16 }}>
          <ActionRow
            title={action.label}
            subtitle={
              action.confirm
                ? confirmMove(action.to).body
                : "The move is called off, and the agent carries on where it is."
            }
            busy={move.busy}
            onPress={() => move.go(action)}
          />
        </Group>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Dream usage
// ---------------------------------------------------------------------------

function DreamPage(props: { readonly page: ProjectCostsPage }) {
  const { page } = props
  return (
    <>
      <View style={{ marginTop: 14 }}>
        <Total total={page.total} aside={page.lastMonth} size={34} />
      </View>
      <Text style={{ fontSize: 14, lineHeight: 19.6, color: color.t3 }}>{page.about}</Text>
      {page.rows.length > 0 ? (
        <>
          <SectionHeading>What it paid for</SectionHeading>
          {page.rows.map((row) => (
            <CostRow key={row.key} row={row} nested />
          ))}
        </>
      ) : null}
      <Footnote>{costsFootnote}</Footnote>
    </>
  )
}
