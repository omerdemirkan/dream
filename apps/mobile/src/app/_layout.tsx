/**
 * The app shell: atom registry, safe areas, the sign-in gate, the navigator,
 * and what floats above it (the expanded message, the toast, media viewer).
 */
import { RegistryProvider, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Stack } from "expo-router"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"
import { View } from "react-native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { sessionAtom } from "../state/atoms.ts"
import { DeviceHost } from "../ui/DeviceHost.tsx"
import { FixturesLaunch } from "../ui/FixturesLaunch.tsx"
import { FocusOverlay } from "../ui/FocusOverlay.tsx"
import { MediaViewer } from "../ui/Media.tsx"
import { color } from "../ui/theme.ts"
import { Toast } from "../ui/Toast.tsx"

void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  return (
    <RegistryProvider>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.bg }}>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <Shell />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </RegistryProvider>
  )
}

function Shell() {
  const session = useAtomValue(sessionAtom)
  const ready = !AsyncResult.isInitial(session)
  const signedIn = Option.isSome(Option.flatten(AsyncResult.value(session)))
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])
  if (!ready) return <View style={{ flex: 1, backgroundColor: color.bg }} />
  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" options={{ animation: "fade" }} />
        </Stack.Protected>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="index" />
          <Stack.Screen
            name="project/[id]"
            options={({ route }) => ({
              animation:
                typeof route.params === "object" && route.params !== null && "instant" in route.params
                  ? "none"
                  : "default"
            })}
          />
          <Stack.Screen name="new" options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }} />
          <Stack.Screen name="connect" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="oauth/google" options={{ animation: "none" }} />
        </Stack.Protected>
        <Stack.Screen name="fixtures/[scenario]" options={{ animation: "none" }} />
      </Stack>
      {signedIn ? <DeviceHost /> : null}
      <FixturesLaunch />
      <FocusOverlay />
      <Toast />
      <MediaViewer />
    </>
  )
}
