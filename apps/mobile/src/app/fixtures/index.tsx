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
      { title: "Needs you", scenarios: ["reset"], to: "/" },
      { title: "All clear", scenarios: ["reset", "all-clear"], to: "/" },
      { title: "New idea", to: "/new" },
      { title: "New idea · long", to: "/new?sample=long" },
      { title: "New idea · dictating", to: "/new?dictate=1" },
      { title: "New idea · dictating into a long one", to: "/new?sample=long&dictate=1" }
    ]
  },
  {
    title: "Projects",
    jumps: [
      { title: "Lift Log · Status", scenarios: ["reset"], to: "/project/prj_liftlog" },
      { title: "Lift Log · paused", scenarios: ["reset", "paused"], to: "/project/prj_liftlog" },
      { title: "Lift Log · Chat", scenarios: ["reset"], to: "/project/prj_liftlog?tab=chat" },
      { title: "Morning Brief · Status", scenarios: ["reset"], to: "/project/prj_morningbrief" },
      { title: "Morning Brief · Chat", scenarios: ["reset"], to: "/project/prj_morningbrief?tab=chat" },
      { title: "Cabin · Status", scenarios: ["reset"], to: "/project/prj_cabin" },
      { title: "Cabin · Chat", scenarios: ["reset"], to: "/project/prj_cabin?tab=chat" },
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
        title: "Cabin · next write times out",
        scenarios: ["reset", "stall-next-write"],
        to: "/project/prj_cabin?tab=chat"
      },
      { title: "Recipe Scaler · Status", scenarios: ["reset"], to: "/project/prj_recipescaler" },
      { title: "Recipe Scaler · Chat", scenarios: ["reset"], to: "/project/prj_recipescaler?tab=chat" }
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
