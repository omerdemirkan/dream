/**
 * A project's usage sheet, direction B ("Read, then adjust": mocks/screens/usage-sheet-directions). The header's
 * ring opens it over the project. It says where the project stands in a few sentences: its share of the plan's week
 * beside a small ring, what Dream paid to run it (opening into the lines it paid for), and how it's set up. One
 * button, Adjust, leads to everything they can change: both limits, the agent's model and effort, and the plan. When
 * something holds the project back and a tap would fix it (a limit they set, or a plan running out while their other
 * has room), that fix sits beside Adjust. What it says comes from `data/usage.ts`, `data/costs.ts`,
 * `data/advanced.ts` and `data/planSwitch.ts`.
 */
import type { ModelConnection, Project, ProjectId, ProjectUsage } from "@dream/domain"
import { providerOf } from "@dream/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import * as Haptics from "expo-haptics"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from "react-native"
import Animated, { Easing, LinearTransition, SlideInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { modelRows, setupSentence } from "../data/advanced.ts"
import { projectCostsSummary } from "../data/costs.ts"
import { providerName, type Sentence, sentenceText } from "../data/format.ts"
import { connectedPlans } from "../data/plans.ts"
import { moveAction, type PlanLine, planNotice } from "../data/planSwitch.ts"
import { limitsView, type UsageFix, usageSummary, withLimit } from "../data/usage.ts"
import { modelConnectionsAtom, projectCostsAtom, projectUsageAtom, setUsageLimitsFn } from "../state/atoms.ts"
import { useAction } from "./actions.ts"
import { AgentPicker, Segmented, useAgentChoice, usePlanMove } from "./Advanced.tsx"
import { CostRow } from "./Costs.tsx"
import { useNow } from "./hooks.ts"
import { Button, Icon, IconButton } from "./kit.tsx"
import { color, gutter, tracking } from "./theme.ts"
import { Footnote, LimitField, SectionHeading, UsageRing } from "./Usage.tsx"

/** What the sheet needs of the project: its agent, its plan, and a move under way. */
export type SheetProject = Pick<Project, "id" | "harness" | "agentModel" | "agentEffort" | "planSwitch">

/**
 * Where the sheet opens: the summary, the summary with what Dream paid opened, Adjust, or Adjust asking at once
 * whether to move the project to their other plan.
 */
export type UsageSheetStart = "summary" | "costs" | "adjust" | "move"

const ease = Easing.bezier(0.2, 0.8, 0.2, 1)

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
            start={props.start ?? "summary"}
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
  const { height } = useWindowDimensions()
  const [page, setPage] = useState<"summary" | "adjust">(
    props.start === "adjust" || props.start === "move" ? "adjust" : "summary"
  )
  // Asked once, as the sheet opens; coming back to Adjust later doesn't ask again.
  const [askToMove, setAskToMove] = useState(props.start === "move")
  const top = insets.top + 50
  return (
    <Animated.View
      entering={SlideInDown.duration(340).easing(ease)}
      layout={LinearTransition.duration(280).easing(ease)}
      style={[
        {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: color.s1,
          borderTopLeftRadius: 30,
          borderTopRightRadius: 30,
          borderCurve: "continuous",
          borderWidth: 1,
          borderBottomWidth: 0,
          borderColor: color.line2,
          overflow: "hidden"
        },
        // The summary is as tall as what it says; Adjust takes the height under the project's header.
        page === "adjust" ? { top } : { maxHeight: height - top }
      ]}
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
      <Content
        projectId={props.projectId}
        title={props.title}
        project={props.project}
        page={page}
        costsOpen={props.start === "costs"}
        askToMove={askToMove}
        onAdjust={() => setPage("adjust")}
        onBack={() => {
          Keyboard.dismiss()
          setAskToMove(false)
          setPage("summary")
        }}
        onClose={props.onClose}
        bottom={Math.max(insets.bottom, 16) + 12}
      />
    </Animated.View>
  )
}

function Content(props: {
  readonly projectId: ProjectId
  readonly title: string
  readonly project: SheetProject | undefined
  readonly page: "summary" | "adjust"
  readonly costsOpen: boolean
  readonly askToMove: boolean
  readonly onAdjust: () => void
  readonly onBack: () => void
  readonly onClose: () => void
  readonly bottom: number
}) {
  const result = useAtomValue(projectUsageAtom(props.projectId))
  // The family keeps the last fetch, so opening the sheet fetches again, and shows the spinner rather than the
  // figures from the last time it was open.
  const refresh = useAtomRefresh(projectUsageAtom(props.projectId))
  useEffect(() => refresh(), [refresh])
  // What saving a limit returned, newer than the fetch.
  const [saved, setSaved] = useState<ProjectUsage | undefined>(undefined)
  const fetched = result.waiting ? undefined : Option.getOrUndefined(AsyncResult.value(result))
  const usage = saved ?? fetched
  const connections = Option.getOrUndefined(AsyncResult.value(useAtomValue(modelConnectionsAtom))) ?? []
  const body =
    usage === undefined ? (
      AsyncResult.isFailure(result) ? (
        <Text style={{ fontSize: 14.5, color: color.t2, marginTop: 24 }}>Usage isn’t available right now.</Text>
      ) : (
        <ActivityIndicator color={color.t3} style={{ marginVertical: 40 }} />
      )
    ) : props.page === "adjust" ? (
      <Adjust
        projectId={props.projectId}
        project={props.project}
        usage={usage}
        connections={connections}
        askToMove={props.askToMove}
        onSaved={setSaved}
      />
    ) : (
      <Summary
        projectId={props.projectId}
        project={props.project}
        usage={usage}
        connections={connections}
        costsOpen={props.costsOpen}
        onAdjust={props.onAdjust}
        onSaved={setSaved}
      />
    )
  return props.page === "adjust" ? (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: gutter, marginBottom: 4 }}>
        <IconButton icon="back" size={32} tone="quiet" label="Back" onPress={props.onBack} />
        <Text
          style={{
            flex: 1,
            textAlign: "center",
            fontSize: 17,
            fontWeight: "600",
            letterSpacing: tracking(-0.02, 17),
            color: color.t1
          }}
        >
          Adjust
        </Text>
        <IconButton icon="close" size={32} tone="quiet" label="Close" onPress={props.onClose} />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: props.bottom }}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {body}
      </ScrollView>
    </>
  ) : (
    <ScrollView
      style={{ flexGrow: 0, flexShrink: 1 }}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: props.bottom }}
      showsVerticalScrollIndicator={false}
    >
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
      {body}
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

function Summary(props: {
  readonly projectId: ProjectId
  readonly project: SheetProject | undefined
  readonly usage: ProjectUsage
  readonly connections: ReadonlyArray<ModelConnection>
  readonly costsOpen: boolean
  readonly onAdjust: () => void
  readonly onSaved: (usage: ProjectUsage) => void
}) {
  const { usage, project } = props
  const now = useNow(30_000)
  const summary = usageSummary(usage, project ?? {}, props.connections, now)
  const notice = project ? planNotice(project, connectedPlans(props.connections), now) : undefined
  const setup = project ? setupSentence(project, usage.limits ?? {}, usage.limitReached?.limit) : undefined
  const save = useAction(setUsageLimitsFn)
  const move = usePlanMove(props.projectId)
  const fix = summary.fix
  const runFix = (fix: UsageFix) => {
    if (fix._tag === "Move") return move.go(moveAction(fix.to))
    void Haptics.selectionAsync()
    save.run(
      { projectId: props.projectId, limits: withLimit(usage.limits ?? {}, fix.limit, undefined) },
      { onSuccess: props.onSaved }
    )
  }
  const quiet = [setup, summary.otherPlan].filter((s) => s !== undefined).join(" ")
  return (
    <>
      <Paragraph first>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 16 }}>
          {summary.ring ? (
            <View style={{ width: 64, height: 64 }}>
              <UsageRing
                size={64}
                stroke={8}
                arcs={summary.ring.arcs}
                focusColor={summary.ring.need ? color.need : color.t1}
              />
              <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: "700",
                    letterSpacing: tracking(-0.03, 15),
                    color: summary.ring.need ? color.need : color.t1,
                    fontVariant: ["tabular-nums"]
                  }}
                >
                  {summary.ring.label}
                </Text>
              </View>
            </View>
          ) : null}
          <SentenceText sentence={summary.plan} style={{ flex: 1 }} />
        </View>
      </Paragraph>
      <CostsParagraph projectId={props.projectId} open={props.costsOpen} />
      {quiet !== "" || notice ? (
        <Paragraph quiet>
          <Text style={{ fontSize: 14.5, lineHeight: 20.5, color: color.t3, letterSpacing: -0.1 }}>
            {quiet}
            {notice ? (
              <>
                {quiet === "" ? "" : " "}
                <NoticeText notice={notice} onAction={move.go} busy={move.busy} />
              </>
            ) : null}
          </Text>
        </Paragraph>
      ) : null}
      <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
        {fix ? (
          <Button
            title={fix._tag === "Move" ? `Move to ${providerName(fix.to)}` : "Clear the limit"}
            busy={fix._tag === "Move" ? move.busy : save.busy}
            onPress={() => runFix(fix)}
            style={{ flex: 1 }}
          />
        ) : null}
        <Button
          title="Adjust"
          variant="ghost"
          {...(fix ? {} : { leading: "sliders" as const })}
          accessibilityHint="Limits, the agent and the plan"
          onPress={props.onAdjust}
          style={{ flex: 1, backgroundColor: color.s3, borderColor: color.line2 }}
        />
      </View>
    </>
  )
}

/** What Dream paid for the project this month: a sentence, which opens into its lines when there are several. */
function CostsParagraph(props: { readonly projectId: ProjectId; readonly open: boolean }) {
  const atom = projectCostsAtom(props.projectId)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  useEffect(() => refresh(), [refresh])
  const [open, setOpen] = useState(props.open)
  const costs = result.waiting ? undefined : Option.getOrUndefined(AsyncResult.value(result))
  const summary = costs ? projectCostsSummary(costs) : undefined
  if (!summary) return null
  const opens = summary.rows.length > 0
  const sentence = <SentenceText sentence={summary.sentence} style={{ flex: 1 }} />
  return (
    <Paragraph>
      {opens ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={sentenceText(summary.sentence)}
          accessibilityHint={open ? "Hides what it paid for" : "Shows what it paid for"}
          onPress={() => setOpen((o) => !o)}
          style={({ pressed }) => ({ flexDirection: "row", gap: 12, opacity: pressed ? 0.6 : 1 })}
        >
          {sentence}
          <View style={{ paddingTop: 4 }}>
            <Icon name={open ? "chevUp" : "chevDown"} size={13} color={color.t3} weight="semibold" />
          </View>
        </Pressable>
      ) : (
        sentence
      )}
      {opens && open ? (
        <View style={{ marginTop: 10 }}>
          {summary.rows.map((row) => (
            <CostRow key={row.key} row={row} nested={false} />
          ))}
          <Footnote>
            {summary.lastMonth ? `${summary.lastMonth}. These are estimates.` : "These are estimates."}
          </Footnote>
        </View>
      ) : null}
    </Paragraph>
  )
}

/** The plan sentence's parts: figures in white, what holds the project back in amber. */
function SentenceText(props: { readonly sentence: Sentence; readonly style?: object }) {
  return (
    <Text style={[{ fontSize: 16, lineHeight: 23, letterSpacing: -0.15, color: color.t2 }, props.style]}>
      {props.sentence.map((part, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: a sentence's parts never move
          key={i}
          style={
            part.tone === "strong"
              ? { color: color.t1, fontWeight: "600" }
              : part.tone === "need"
                ? { color: color.need, fontWeight: "600" }
                : undefined
          }
        >
          {part.text}
        </Text>
      ))}
    </Text>
  )
}

/** A move waiting or one that didn't work, with what they can do about it. */
function NoticeText(props: {
  readonly notice: PlanLine
  readonly onAction: (action: NonNullable<PlanLine["action"]>) => void
  readonly busy: boolean
}) {
  const { notice } = props
  return (
    <>
      {notice.text}
      {notice.action ? (
        <>
          {"  "}
          <Text
            accessibilityRole="button"
            suppressHighlighting={false}
            onPress={() => notice.action && props.onAction(notice.action)}
            style={{ fontWeight: "600", color: props.busy ? color.t3 : color.t2 }}
          >
            {notice.action.label}
          </Text>
        </>
      ) : null}
    </>
  )
}

/** One of the summary's parts, under a hairline (the first has none). */
function Paragraph(props: { readonly children: ReactNode; readonly first?: boolean; readonly quiet?: boolean }) {
  return (
    <View
      style={{
        marginTop: props.first ? 16 : 0,
        paddingTop: props.first ? 0 : props.quiet ? 16 : 18,
        paddingBottom: props.quiet ? 0 : 18,
        borderTopWidth: props.first ? 0 : StyleSheet.hairlineWidth,
        borderColor: color.line
      }}
    >
      {props.children}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Adjust
// ---------------------------------------------------------------------------

/**
 * Everything they can change about the project's use of the plan, as the new-idea screen's Advanced sheet has it:
 * the two limits, the agent's model and effort, and the plan (with more than one connected, or a move under way).
 */
function Adjust(props: {
  readonly projectId: ProjectId
  readonly project: SheetProject | undefined
  readonly usage: ProjectUsage
  readonly connections: ReadonlyArray<ModelConnection>
  readonly askToMove: boolean
  readonly onSaved: (usage: ProjectUsage) => void
}) {
  const { usage } = props
  const save = useAction(setUsageLimitsFn)
  const limits = usage.limits ?? {}
  const view = limitsView(usage)
  const change = (which: "project" | "planLeft", value: number | undefined) => {
    const next = withLimit(limits, which, value)
    if (next.projectWeekPercent === limits.projectWeekPercent && next.planLeftPercent === limits.planLeftPercent) return
    save.run({ projectId: props.projectId, limits: next }, { onSuccess: props.onSaved })
  }
  return (
    <>
      <SectionHeading>Limits</SectionHeading>
      <LimitField
        before="This project may use up to"
        after="of the week"
        label="Most of the week this project may use, in percent"
        row={view.project}
        onChange={(value) => change("project", value)}
      />
      <LimitField
        before="Stop when the plan has"
        after="left"
        label="Pause when this much of the plan is left, in percent"
        row={view.planLeft}
        onChange={(value) => change("planLeft", value)}
      />
      {props.project ? (
        <>
          <AgentSection project={props.project} />
          <PlanSection
            projectId={props.projectId}
            project={props.project}
            connections={props.connections}
            askToMove={props.askToMove}
          />
        </>
      ) : null}
      <Footnote>Shares are estimates. The agent picks its helpers’ models itself.</Footnote>
    </>
  )
}

function AgentSection(props: { readonly project: SheetProject }) {
  const agent = useAgentChoice(props.project)
  return (
    <>
      <AgentPicker
        models={modelRows(props.project.harness, agent.model)}
        effort={agent.effort}
        onModel={(model) => agent.change({ model, effort: agent.effort })}
        onEffort={(effort) => agent.change({ model: agent.model, effort })}
      />
      {agent.changed ? <Footnote>It switches at its next turn.</Footnote> : null}
    </>
  )
}

/**
 * The plan it runs on, as two segments when they have both; choosing the other asks before moving it. While a move
 * waits, or after one didn't work, a line says so with what they can do.
 */
function PlanSection(props: {
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
  // `?sheet=plan`: ask at once, once the page has slid up.
  const asked = useRef(false)
  useEffect(() => {
    if (!props.askToMove || asked.current || other === undefined || waiting) return
    const timer = setTimeout(() => {
      asked.current = true
      move.go(moveAction(other))
    }, 500)
    return () => clearTimeout(timer)
  }, [props.askToMove, other, waiting])
  if (plans.length < 2 && notice === undefined) return null
  return (
    <>
      <SectionHeading>Plan</SectionHeading>
      {plans.length > 1 ? (
        <Segmented
          options={plans.map((provider) => ({ value: provider, label: providerName(provider) }))}
          chosen={current}
          onChoose={(provider) => {
            if (provider !== current && !waiting) move.go(moveAction(provider))
          }}
        />
      ) : null}
      <Text style={{ fontSize: 13, lineHeight: 18, color: color.t3, marginTop: 10 }}>
        {notice ? (
          <NoticeText notice={notice} onAction={move.go} busy={move.busy} />
        ) : (
          `Moving hands the agent’s work to one on the other plan, which picks up where it left off. The project, its apps and its schedules stay as they are.`
        )}
      </Text>
    </>
  )
}
