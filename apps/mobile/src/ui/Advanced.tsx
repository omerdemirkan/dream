/**
 * Advanced: a project's starting settings, behind a round button beside Send on the new-idea screen. The sheet holds
 * the plan (only with more than one connected), the agent's model and reasoning effort, and the two usage limits;
 * left alone, the project starts as it always has. What it says comes from `data/advanced.ts`. The agent's part
 * (`AgentPicker`) is also the usage sheet's, where a project's model and effort can be changed later, and where
 * someone with more than one plan can move the project to another (`PlanRow`). The sheet is drawn like the usage
 * sheet (mocks/screens/project-usage, `.sheet`).
 */
import type { ModelProvider, Project, ReasoningEffort, UsageLimits } from "@dream/domain"
import { agentChoice, agentOf, ReasoningEfforts } from "@dream/domain"
import * as Haptics from "expo-haptics"
import { useEffect, useState } from "react"
import { Alert, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import Animated, { Easing, SlideInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { type AdvancedView, agentLabel, effortAbout, effortName, type ModelRow, modelRows } from "../data/advanced.ts"
import { providerName } from "../data/format.ts"
import { type PlanLine, planLine } from "../data/planSwitch.ts"
import { withLimit } from "../data/usage.ts"
import { setAgentModelFn, switchPlanFn } from "../state/atoms.ts"
import { useAction } from "./actions.ts"
import { useConnectedPlans, useNow } from "./hooks.ts"
import { Icon, IconButton } from "./kit.tsx"
import { color, gutter, tracking } from "./theme.ts"
import { Footnote, LimitField, SectionHeading } from "./Usage.tsx"

/** The button beside Send, shaped like the composer's others, with a dot once anything differs from the defaults. */
export function AdvancedButton(props: { readonly changed: boolean; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.changed ? "Advanced settings, changed" : "Advanced settings"}
      onPress={props.onPress}
      style={({ pressed }) => ({
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: pressed ? color.s3 : color.s2,
        borderWidth: 1,
        borderColor: color.line2,
        alignItems: "center",
        justifyContent: "center"
      })}
    >
      <Icon name="sliders" size={22} color={color.t1} />
      {props.changed ? (
        <View
          style={{
            position: "absolute",
            top: 13,
            right: 13,
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: color.t1,
            borderWidth: 1.5,
            borderColor: color.s2
          }}
        />
      ) : null}
    </Pressable>
  )
}

export function AdvancedSheet(props: {
  readonly open: boolean
  readonly onClose: () => void
  readonly view: AdvancedView
  readonly onPlan: (provider: ModelProvider) => void
  readonly onModel: (model: string) => void
  readonly onEffort: (effort: ReasoningEffort) => void
  readonly onLimits: (limits: UsageLimits) => void
  readonly onReset: () => void
}) {
  const { view } = props
  const insets = useSafeAreaInsets()
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
          <Animated.View
            entering={SlideInDown.duration(340).easing(Easing.bezier(0.2, 0.8, 0.2, 1))}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              maxHeight: "92%",
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
            <ScrollView
              contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: Math.max(insets.bottom, 16) + 12 }}
              showsVerticalScrollIndicator={false}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              automaticallyAdjustKeyboardInsets
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <Text
                  style={{
                    flex: 1,
                    fontSize: 20,
                    fontWeight: "700",
                    letterSpacing: tracking(-0.035, 20),
                    color: color.t1
                  }}
                >
                  Advanced
                </Text>
                {view.changed ? (
                  <Pressable accessibilityRole="button" onPress={props.onReset} hitSlop={8}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: color.t2 }}>Use defaults</Text>
                  </Pressable>
                ) : null}
                <IconButton icon="close" size={32} tone="quiet" label="Close" onPress={close} />
              </View>
              {view.plans.length > 1 && view.provider !== undefined ? (
                <>
                  <SectionHeading>Plan</SectionHeading>
                  <Segmented
                    options={view.plans.map((provider) => ({ value: provider, label: providerName(provider) }))}
                    chosen={view.provider}
                    onChoose={props.onPlan}
                  />
                </>
              ) : null}
              {view.models.length > 0 ? (
                <AgentPicker
                  models={view.models}
                  effort={view.effort}
                  onModel={props.onModel}
                  onEffort={props.onEffort}
                />
              ) : null}
              <SectionHeading>Limits</SectionHeading>
              <LimitField
                before="This project may use up to"
                after="of the week"
                label="Most of the week this project may use, in percent"
                row={{ value: view.limits.projectWeekPercent, reached: false }}
                onChange={(value) => props.onLimits(withLimit(view.limits, "project", value))}
              />
              <LimitField
                before="Stop when the plan has"
                after="left"
                label="Pause when this much of the plan is left, in percent"
                row={{ value: view.limits.planLeftPercent, reached: false }}
                onChange={(value) => props.onLimits(withLimit(view.limits, "planLeft", value))}
              />
              <Footnote>The agent picks its helpers’ models itself.</Footnote>
            </ScrollView>
          </Animated.View>
        ) : null}
      </View>
    </Modal>
  )
}

/** The agent's model, one row each, then its reasoning effort. */
export function AgentPicker(props: {
  readonly models: ReadonlyArray<ModelRow>
  readonly effort: ReasoningEffort
  readonly onModel: (model: string) => void
  readonly onEffort: (effort: ReasoningEffort) => void
  /** The usage sheet draws its own heading. */
  readonly heading?: boolean
}) {
  return (
    <>
      {props.heading === false ? null : <SectionHeading>Agent</SectionHeading>}
      {props.models.map((model) => (
        <Pressable
          key={model.id}
          accessibilityRole="radio"
          accessibilityState={{ selected: model.chosen }}
          accessibilityLabel={`${model.name}${model.isDefault ? ", Dream’s default" : ""}. ${model.about}`}
          onPress={() => props.onModel(model.id)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 11,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderColor: color.line,
            opacity: pressed ? 0.6 : 1
          })}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15.5, fontWeight: "600", color: color.t1, letterSpacing: -0.15 }}>
              {model.name}
              {model.isDefault ? (
                <Text style={{ fontSize: 13, fontWeight: "400", color: color.t3 }}> Default</Text>
              ) : null}
            </Text>
            <Text style={{ fontSize: 13, color: color.t3, marginTop: 2 }}>{model.about}</Text>
          </View>
          {model.chosen ? <Icon name="check" size={15} color={color.t1} weight="semibold" /> : null}
        </Pressable>
      ))}
      <EffortPicker effort={props.effort} onEffort={props.onEffort} />
    </>
  )
}

/** Reasoning effort as five rising bars, lit up to the chosen level, with what it does under them. */
function EffortPicker(props: {
  readonly effort: ReasoningEffort
  readonly onEffort: (effort: ReasoningEffort) => void
}) {
  const chosen = ReasoningEfforts.indexOf(props.effort)
  return (
    <View style={{ marginTop: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 15, color: color.t1, letterSpacing: -0.15 }}>Reasoning</Text>
        <Text style={{ fontSize: 15, fontWeight: "600", color: color.t1 }}>{effortName[props.effort]}</Text>
      </View>
      <View
        accessibilityRole="adjustable"
        style={{
          flexDirection: "row",
          height: 52,
          marginTop: 10,
          borderRadius: 14,
          borderCurve: "continuous",
          backgroundColor: color.s2,
          borderWidth: 1,
          borderColor: color.line2,
          paddingHorizontal: 6
        }}
      >
        {ReasoningEfforts.map((effort, index) => (
          <Pressable
            key={effort}
            accessibilityRole="radio"
            accessibilityState={{ selected: index === chosen }}
            accessibilityLabel={`${effortName[effort]} reasoning`}
            onPress={() => props.onEffort(effort)}
            style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", paddingBottom: 12 }}
          >
            <View
              style={{
                width: 7,
                height: 9 + index * 6,
                borderRadius: 3.5,
                backgroundColor: index <= chosen ? color.t1 : "rgba(255,255,255,0.14)"
              }}
            />
          </Pressable>
        ))}
      </View>
      <Text style={{ fontSize: 13, color: color.t3, marginTop: 8 }}>{effortAbout[props.effort]}</Text>
    </View>
  )
}

function Segmented<A extends string>(props: {
  readonly options: ReadonlyArray<{ readonly value: A; readonly label: string }>
  readonly chosen: A
  readonly onChoose: (value: A) => void
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        height: 40,
        marginTop: 8,
        padding: 3,
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: color.s2,
        borderWidth: 1,
        borderColor: color.line
      }}
    >
      {props.options.map((option) => {
        const on = option.value === props.chosen
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => props.onChoose(option.value)}
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 9,
              borderCurve: "continuous",
              backgroundColor: on ? color.s3 : "transparent",
              borderWidth: on ? 1 : 0,
              borderColor: color.line2
            }}
          >
            <Text style={{ fontSize: 14.5, fontWeight: "600", color: on ? color.t1 : color.t2 }}>{option.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * The usage sheet's Agent: the project's model and effort on one line, which opens into the picker. A change is
 * saved at once and takes effect from the agent's next turn, in the same conversation.
 */
export function ProjectAgent(props: {
  readonly project: Pick<Project, "id" | "harness" | "agentModel" | "agentEffort" | "planSwitch">
}) {
  const save = useAction(setAgentModelFn)
  const [open, setOpen] = useState(false)
  // What they chose here, ahead of the project record catching up over the live stream.
  const [chosen, setChosen] = useState<Pick<Project, "agentModel" | "agentEffort"> | undefined>(undefined)
  const [changed, setChanged] = useState(false)
  // A move to another plan brings its own model names; what was chosen on the old one no longer applies.
  useEffect(() => {
    setChosen(undefined)
    setChanged(false)
  }, [props.project.harness])
  const current = { harness: props.project.harness, ...(chosen ?? props.project) }
  const { model, effort } = agentOf(current)
  const change = (next: { readonly model: string; readonly effort: ReasoningEffort }) => {
    if (next.model === model && next.effort === effort) return
    const choice = agentChoice(props.project.harness, next)
    setChosen(choice)
    setChanged(true)
    save.run(
      { projectId: props.project.id, model: next.model, effort: next.effort },
      { onFailure: () => setChosen(undefined) }
    )
  }
  return (
    <>
      <SectionHeading>Agent</SectionHeading>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${agentLabel(current)}. ${open ? "Hide choices" : "Change"}`}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: color.line,
          opacity: pressed ? 0.6 : 1
        })}
      >
        <Text style={{ flex: 1, fontSize: 15, color: color.t1, letterSpacing: -0.15 }}>{agentLabel(current)}</Text>
        <Icon name={open ? "chevUp" : "chevDown"} size={13} color={color.t3} weight="semibold" />
      </Pressable>
      {open ? (
        <AgentPicker
          heading={false}
          models={modelRows(props.project.harness, model)}
          effort={effort}
          onModel={(m) => change({ model: m, effort })}
          onEffort={(e) => change({ model, effort: e })}
        />
      ) : null}
      {changed ? <Footnote>It switches at its next turn.</Footnote> : null}
      <PlanRow project={props.project} />
    </>
  )
}

/**
 * The plan the project runs on, and a move to another of theirs: one quiet line, there only for someone with more
 * than one plan (or a move under way). The move asks first; staying, while one waits, doesn't.
 */
function PlanRow(props: { readonly project: Pick<Project, "id" | "harness" | "planSwitch"> }) {
  const plans = useConnectedPlans()
  const now = useNow(60_000)
  const move = useAction(switchPlanFn)
  const line = planLine(props.project, plans, now)
  if (line === undefined) return null
  const go = (action: NonNullable<PlanLine["action"]>) => {
    if (move.busy) return
    const run = () => {
      void Haptics.selectionAsync()
      move.run({ projectId: props.project.id, to: action.to })
    }
    if (action.confirm === undefined) return run()
    Alert.alert(action.confirm.title, action.confirm.body, [
      { text: "Cancel", style: "cancel" },
      { text: action.confirm.button, onPress: run }
    ])
  }
  return (
    <Text style={{ fontSize: 13, lineHeight: 18, color: color.t3, marginTop: 12 }}>
      {line.text}
      {line.action ? (
        <>
          {"  "}
          <Text
            accessibilityRole="button"
            suppressHighlighting={false}
            onPress={() => line.action && go(line.action)}
            style={{ fontWeight: "600", color: move.busy ? color.t3 : color.t2 }}
          >
            {line.action.label}
          </Text>
        </>
      ) : null}
    </Text>
  )
}
