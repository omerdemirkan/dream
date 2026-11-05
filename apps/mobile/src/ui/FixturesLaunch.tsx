/**
 * Fixtures mode only: opens a screen state named in the launch arguments, so
 * every state can be reached in the Simulator without tapping:
 *
 *   xcrun simctl launch --terminate-running-process booted com.omer.dream \
 *     -dreamScenario signed-in,cabin-resolved -dreamRoute "/project/prj_cabin?tab=chat"
 */
import { type Href, useRouter } from "expo-router"
import { useEffect, useRef } from "react"
import { LogBox } from "react-native"
import { DreamNative } from "../../modules/dream-native/index.ts"
import { appConfig } from "../state/runtime.ts"
import { parseScenarios, useScenarios } from "./useScenarios.ts"

export function FixturesLaunch() {
  const router = useRouter()
  const scenarios = useScenarios()
  const done = useRef(false)
  useEffect(() => {
    if (done.current || appConfig.backend !== "fixtures" || !DreamNative) return
    done.current = true
    // `-dreamQuiet YES`: no LogBox toasts over the screen while taking screenshots (Metro still logs).
    if (DreamNative.launchArgument("dreamQuiet") === "YES") LogBox.ignoreAllLogs(true)
    const route = DreamNative.launchArgument("dreamRoute")
    void scenarios(parseScenarios(DreamNative.launchArgument("dreamScenario"))).then(() => {
      // A path inside this app, typed by whoever launched the Simulator.
      if (route?.startsWith("/")) setTimeout(() => router.replace(route as Href), 300)
    })
  }, [scenarios, router])
  return null
}
