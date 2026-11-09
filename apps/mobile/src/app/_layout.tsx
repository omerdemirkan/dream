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
import { KeyboardProvider } from "react-native-keyboard-controller"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { installErrorReporting } from "../platform/errorReporting.ts"
import { appConfig } from "../state/runtime.ts"
import { sessionAtom } from "../state/atoms.ts"
import { declineAtom, focusAtom, optionsViewerAtom, toastAtom, viewerAtom } from "../state/ui.ts"
import { DeviceHost } from "../ui/DeviceHost.tsx"
import { LayerBoundary, ScreenBoundary, ScreenTracker } from "../ui/ErrorBoundary.tsx"
import { FixturesLaunch } from "../ui/FixturesLaunch.tsx"
import { FocusOverlay } from "../ui/FocusOverlay.tsx"
import { DeclineHost } from "../ui/Decline.tsx"
import { MediaViewer } from "../ui/Media.tsx"
import { OptionsViewerHost } from "../ui/Options.tsx"
import { color } from "../ui/theme.ts"
import { Toast } from "../ui/Toast.tsx"
import { UpdatesHost } from "../ui/UpdatesHost.tsx"

// Reports go to the API in live builds; fixtures builds only log them.
installErrorReporting({ apiUrl: appConfig.backend === "live" ? appConfig.apiUrl : undefined })
void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  return (
    <RegistryProvider>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.bg }}>
        <SafeAreaProvider>
          <KeyboardProvider>
            <StatusBar style="light" />
            <Shell />
          </KeyboardProvider>
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
      <ScreenTracker />
      <ScreenBoundary>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="sign-in" options={{ animation: "fade" }} />
          </Stack.Protected>
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="index" />
            <Stack.Screen
              name="project/[id]"
              options={({ route }) => ({
                presentation: "card",
                animation:
                  typeof route.params === "object" && route.params !== null && "instant" in route.params
                    ? "none"
                    : "default"
              })}
            />
            <Stack.Screen name="new" options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }} />
            <Stack.Screen name="connect" />
            <Stack.Screen name="settings" />
            <Stack.Screen name="plan/[provider]" />
            <Stack.Screen name="costs/index" />
            <Stack.Screen name="costs/everyone" />
            <Stack.Screen name="service/[id]" />
            <Stack.Screen name="archived" />
            <Stack.Screen name="account" />
            <Stack.Screen name="oauth/google" options={{ animation: "none" }} />
          </Stack.Protected>
          <Stack.Screen name="fixtures/[scenario]" options={{ animation: "none" }} />
          <Stack.Screen name="fixtures/index" />
        </Stack>
      </ScreenBoundary>
      {signedIn ? <DeviceHost /> : null}
      <UpdatesHost />
      <FixturesLaunch />
      {/* Each layer over the screens closes by itself if it fails, rather than taking the app down. */}
      <LayerBoundary closes={focusAtom}>
        <FocusOverlay />
      </LayerBoundary>
      <LayerBoundary closes={toastAtom}>
        <Toast />
      </LayerBoundary>
      <LayerBoundary closes={viewerAtom}>
        <MediaViewer />
      </LayerBoundary>
      <LayerBoundary closes={optionsViewerAtom}>
        <OptionsViewerHost />
      </LayerBoundary>
      <LayerBoundary closes={declineAtom}>
        <DeclineHost />
      </LayerBoundary>
    </>
  )
}
