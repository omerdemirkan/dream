/**
 * Fixtures mode only: every screen state of the sample world, one tap away
 * (like the mock's "Jump to a screen" sheet). Reached from Settings.
 */
import { type Href, useRouter } from "expo-router"
import { Pressable, ScrollView, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { IconButton, Lab } from "../../ui/kit.tsx"
import { color, gutter } from "../../ui/theme.ts"
import { useScenarios } from "../../ui/useScenarios.ts"

interface Jump {
  readonly title: string
  readonly scenarios?: ReadonlyArray<string>
  readonly to: string
}

const sections: ReadonlyArray<{ readonly title: string; readonly jumps: ReadonlyArray<Jump> }> = [
  {
    title: "Home",
    jumps: [
      { title: "Projects need you", scenarios: ["reset"], to: "/" },
      { title: "Nothing waiting", scenarios: ["reset", "all-clear"], to: "/" },
      { title: "Home · a plan removed", scenarios: ["reset", "plan-removed"], to: "/" },
      { title: "New idea · two plans", scenarios: ["reset", "two-plans"], to: "/new" },
      { title: "New idea", to: "/new" },
      { title: "New idea · long", to: "/new?sample=long" },
      { title: "New idea · dictating", to: "/new?dictate=1" },
      { title: "New idea · dictating into a long one", to: "/new?sample=long&dictate=1" },
      { title: "New idea · a starter's draft", to: "/new?starter=run-club-bot" },
      {
        title: "New idea · with attachments",
        to: "/new?attach=sample&text=A%20meal%20planner%20for%20our%20week.%20This%20is%20the%20fridge%20whiteboard%20we%20use%20now%2C%20and%20last%20month%E2%80%99s%20grocery%20list."
      }
    ]
  },
  {
    title: "Settings",
    jumps: [
      { title: "Settings · one plan", scenarios: ["reset"], to: "/settings" },
      { title: "Settings · two plans", scenarios: ["reset", "two-plans"], to: "/settings" },
      { title: "Settings · every kind of service", scenarios: ["reset", "services"], to: "/settings" },
      { title: "Settings · a service stopped working", scenarios: ["reset", "spotify-stopped"], to: "/settings" },
      { title: "Settings · near the limit", scenarios: ["reset", "usage-near-limit"], to: "/settings" },
      { title: "Settings · paused at a limit", scenarios: ["reset", "plan-limited"], to: "/settings" },
      {
        title: "Settings · a week Dream hasn't seen",
        scenarios: ["reset", "two-plans", "week-unknown"],
        to: "/settings"
      },
      { title: "Settings · sign-in expired", scenarios: ["reset", "plan-expired"], to: "/settings" },
      { title: "Settings · finishing sign-in", scenarios: ["reset", "plan-pending"], to: "/settings" },
      { title: "Settings · no plan", scenarios: ["reset", "no-plan"], to: "/settings" },
      { title: "Settings · no Dream spend yet", scenarios: ["reset", "costs-none"], to: "/settings" },
      { title: "Settings · archived projects", scenarios: ["reset", "archived"], to: "/settings" },
      { title: "A plan", scenarios: ["reset"], to: "/plan/chatgpt" },
      {
        title: "A plan · Claude, beside ChatGPT",
        scenarios: ["reset", "two-plans", "usage-deleted"],
        to: "/plan/claude"
      },
      { title: "A plan · near the limit", scenarios: ["reset", "usage-near-limit"], to: "/plan/chatgpt" },
      { title: "A plan · paused at a limit", scenarios: ["reset", "plan-limited"], to: "/plan/chatgpt" },
      { title: "A plan · a week Dream hasn't seen", scenarios: ["reset", "week-unknown"], to: "/plan/chatgpt" },
      { title: "A plan · sign-in expired", scenarios: ["reset", "plan-expired"], to: "/plan/claude" },
      { title: "A plan · finishing sign-in", scenarios: ["reset", "plan-pending"], to: "/plan/claude" },
      { title: "A plan · removing it", scenarios: ["reset", "two-plans"], to: "/plan/claude?show=remove" },
      { title: "Dream usage", scenarios: ["reset"], to: "/costs" },
      { title: "Dream usage · operator", scenarios: ["reset", "costs-operator"], to: "/costs" },
      { title: "Dream usage · everyone", scenarios: ["reset", "costs-operator"], to: "/costs/everyone" },
      { title: "Dream usage · nothing yet", scenarios: ["reset", "costs-none"], to: "/costs" },
      { title: "A service · a sign-in", scenarios: ["reset"], to: "/service/int_google" },
      { title: "A service · a pasted key", scenarios: ["reset", "services"], to: "/service/int_openai" },
      { title: "A service · replacing a key", scenarios: ["reset", "services"], to: "/service/int_openai?replace=1" },
      { title: "A service · a key file", scenarios: ["reset", "services"], to: "/service/int_telegram" },
      { title: "A service · App Store Connect", scenarios: ["reset", "services"], to: "/service/int_apple" },
      { title: "A service · stopped working", scenarios: ["reset", "spotify-stopped"], to: "/service/int_spotify" },
      { title: "Archived projects", scenarios: ["reset", "archived"], to: "/archived" },
      { title: "Archived projects · none", scenarios: ["reset"], to: "/archived" },
      { title: "Account", scenarios: ["reset"], to: "/account" }
    ]
  },
  {
    title: "Projects",
    jumps: [
      { title: "Lift Log · working", scenarios: ["reset"], to: "/project/prj_liftlog" },
      { title: "Lift Log · Status card open", scenarios: ["reset"], to: "/project/prj_liftlog?tab=status" },
      { title: "Lift Log · paused", scenarios: ["reset", "paused"], to: "/project/prj_liftlog" },
      { title: "Lift Log · now on two lines", scenarios: ["reset", "now-two-lines"], to: "/project/prj_liftlog" },
      { title: "Lift Log · now cut at two lines", scenarios: ["reset", "now-three-lines"], to: "/project/prj_liftlog" },
      { title: "Lift Log · usage sheet", scenarios: ["reset"], to: "/project/prj_liftlog?sheet=usage" },
      {
        title: "Lift Log · usage sheet, two plans",
        scenarios: ["reset", "two-plans"],
        to: "/project/prj_liftlog?sheet=usage"
      },
      {
        title: "Lift Log · usage sheet, one plan, nothing paid yet",
        scenarios: ["reset", "costs-none"],
        to: "/project/prj_liftlog?sheet=usage"
      },
      {
        title: "Lift Log · usage near the limit",
        scenarios: ["reset", "usage-near-limit"],
        to: "/project/prj_liftlog"
      },
      {
        title: "Lift Log · usage sheet, near the limit",
        scenarios: ["reset", "usage-near-limit"],
        to: "/project/prj_liftlog?sheet=usage"
      },
      {
        title: "Lift Log · usage sheet, near the limit, Claude has room",
        scenarios: ["reset", "usage-near-limit", "two-plans"],
        to: "/project/prj_liftlog?sheet=usage"
      },
      {
        title: "Lift Log · paused at its usage limit",
        scenarios: ["reset", "usage-limit"],
        to: "/project/prj_liftlog?sheet=usage"
      },
      {
        title: "Lift Log · usage sheet, five hours ran out",
        scenarios: ["reset", "plan-limited", "paused"],
        to: "/project/prj_liftlog?sheet=usage"
      },
      {
        title: "Lift Log · usage sheet, the week ran out",
        scenarios: ["reset", "usage-near-limit", "two-plans", "plan-week-out"],
        to: "/project/prj_liftlog?sheet=usage"
      },
      {
        title: "Lift Log · usage sheet, no usage known",
        scenarios: ["reset", "usage-none"],
        to: "/project/prj_liftlog?sheet=usage"
      },
      { title: "Lift Log · no usage known", scenarios: ["reset", "usage-none"], to: "/project/prj_liftlog" },
      { title: "Lift Log · Limits", scenarios: ["reset"], to: "/project/prj_liftlog?sheet=limits" },
      {
        title: "Lift Log · Limits, paused at one",
        scenarios: ["reset", "usage-limit"],
        to: "/project/prj_liftlog?sheet=limits"
      },
      { title: "Lift Log · Agent", scenarios: ["reset"], to: "/project/prj_liftlog?sheet=agent" },
      { title: "Lift Log · Plan", scenarios: ["reset", "two-plans"], to: "/project/prj_liftlog?sheet=plans" },
      {
        title: "Lift Log · asking to move to Claude",
        scenarios: ["reset", "two-plans"],
        to: "/project/prj_liftlog?sheet=plan"
      },
      {
        title: "Lift Log · moving to Claude",
        scenarios: ["reset", "two-plans", "plan-moving"],
        to: "/project/prj_liftlog?sheet=usage"
      },
      {
        title: "Lift Log · Plan, moving to Claude",
        scenarios: ["reset", "two-plans", "plan-moving"],
        to: "/project/prj_liftlog?sheet=plans"
      },
      {
        title: "Lift Log · Chat, moving to Claude",
        scenarios: ["reset", "two-plans", "plan-moving"],
        to: "/project/prj_liftlog?tab=chat"
      },
      {
        title: "Lift Log · Chat, moved to Claude",
        scenarios: ["reset", "two-plans", "plan-moved"],
        to: "/project/prj_liftlog?tab=chat"
      },
      {
        title: "Lift Log · the move didn’t work",
        scenarios: ["reset", "two-plans", "plan-move-failed"],
        to: "/project/prj_liftlog?sheet=usage"
      },
      {
        title: "Lift Log · Plan, the move didn’t work",
        scenarios: ["reset", "two-plans", "plan-move-failed"],
        to: "/project/prj_liftlog?sheet=plans"
      },
      { title: "Lift Log · Dream usage", scenarios: ["reset"], to: "/project/prj_liftlog?sheet=costs" },
      {
        title: "Lift Log · Dream usage, only machine time",
        scenarios: ["reset", "costs-machine"],
        to: "/project/prj_liftlog?sheet=costs"
      },
      {
        title: "Lift Log · long Chat, scrolled up",
        scenarios: ["reset", "long-chat"],
        to: "/project/prj_liftlog?land=msg_long8"
      },
      { title: "Lift Log · attaching", scenarios: ["reset"], to: "/project/prj_liftlog?tab=chat&attach=sample" },
      {
        title: "Lift Log · sent attachments",
        scenarios: ["reset", "attachments-sent"],
        to: "/project/prj_liftlog?tab=chat"
      },
      { title: "Morning Brief", scenarios: ["reset"], to: "/project/prj_morningbrief" },
      { title: "Morning Brief · Status card open", scenarios: ["reset"], to: "/project/prj_morningbrief?tab=status" },
      { title: "Cabin · needs you", scenarios: ["reset"], to: "/project/prj_cabin" },
      { title: "Cabin · Status card open", scenarios: ["reset"], to: "/project/prj_cabin?tab=status" },
      { title: "New idea · early", scenarios: ["reset", "activity-new-idea"], to: "/project/prj_newidea" },
      { title: "Cabin · Chat · resolved", scenarios: ["reset", "cabin-resolved"], to: "/project/prj_cabin?tab=chat" },
      {
        title: "Cabin · question withdrawn",
        scenarios: ["reset", "withdraw-cabin"],
        to: "/project/prj_cabin?tab=chat"
      },
      {
        title: "Cabin · message this app can’t show",
        scenarios: ["reset", "unsupported-message"],
        to: "/project/prj_cabin?tab=chat"
      },
      {
        title: "Lift Log · live connection slow",
        scenarios: ["reset", "live-slow"],
        to: "/project/prj_liftlog"
      },
      {
        title: "Lift Log · live connection down",
        scenarios: ["reset", "live-down"],
        to: "/project/prj_liftlog"
      },
      {
        title: "Cabin · next write times out",
        scenarios: ["reset", "stall-next-write"],
        to: "/project/prj_cabin?tab=chat"
      },
      { title: "Recipe Scaler", scenarios: ["reset"], to: "/project/prj_recipescaler" }
    ]
  },
  {
    title: "Expanded",
    jumps: [
      { title: "Question", scenarios: ["reset"], to: "/project/prj_cabin?tab=chat&focus=msg_cabinrule" },
      {
        title: "Question · answered",
        scenarios: ["reset", "cabin-resolved"],
        to: "/project/prj_cabin?tab=chat&focus=msg_cabinrule"
      },
      { title: "Access · Google", scenarios: ["reset"], to: "/project/prj_cabin?tab=chat&focus=msg_gcal" },
      { title: "Access · Apple key", scenarios: ["reset"], to: "/project/prj_liftlog?tab=chat&focus=msg_apple" },
      {
        title: "Access · Spotify (OAuth)",
        scenarios: ["reset", "spotify-ask"],
        to: "/project/prj_liftlog?tab=chat&focus=msg_spotify"
      },
      {
        title: "Access · Telegram (key file)",
        scenarios: ["reset"],
        to: "/project/prj_morningbrief?tab=chat&focus=msg_brieftelegram"
      },
      {
        title: "Access · connected",
        scenarios: ["reset"],
        to: "/project/prj_morningbrief?tab=chat&focus=msg_gmail"
      },
      {
        title: "Back in Chat · highlighted",
        scenarios: ["reset"],
        to: "/project/prj_cabin?tab=chat&land=msg_cabinrule"
      }
    ]
  },
  {
    title: "Account",
    jumps: [
      { title: "Connect a plan", to: "/connect" },
      { title: "Sign in", scenarios: ["signed-out"], to: "/" },
      { title: "Live Activity", scenarios: ["live-activity"], to: "/" },
      { title: "Live Activity · needs you", scenarios: ["live-activity-needs"], to: "/" }
    ]
  }
]

export default function FixtureJumps() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const scenarios = useScenarios()
  const go = (jump: Jump) =>
    void scenarios(jump.scenarios ?? []).then(() => {
      router.dismissAll()
      // Paths inside this app, listed above.
      if (jump.to !== "/") router.push(jump.to as Href)
    })
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
        <Text style={{ fontSize: 15, fontWeight: "600", color: color.t2 }}>Sample screens</Text>
        <View style={{ width: 40 }} />
      </View>
      {sections.map((section) => (
        <View key={section.title} style={{ marginTop: 24 }}>
          <Lab style={{ marginBottom: 4 }}>{section.title}</Lab>
          {section.jumps.map((jump) => (
            <Pressable
              key={jump.title}
              accessibilityRole="button"
              onPress={() => go(jump)}
              style={({ pressed }) => ({
                paddingVertical: 13,
                borderBottomWidth: 1,
                borderColor: color.line,
                opacity: pressed ? 0.6 : 1
              })}
            >
              <Text style={{ fontSize: 16, color: color.t1 }}>{jump.title}</Text>
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  )
}
