/**
 * Fixtures mode only: opens a screen state named in the launch arguments, so
 * every state can be reached in the Simulator without tapping:
 *
 *   xcrun simctl launch --terminate-running-process booted com.omer.dream \
 *     -dreamScenario signed-in,cabin-resolved -dreamRoute "/project/prj_cabin?tab=chat"
 */
import { useAtomSet } from "@effect/atom-react"
import { type Href, useRouter } from "expo-router"
import { useEffect, useRef } from "react"
import { DreamNative } from "../../modules/dream-native/index.ts"
import { Scenario } from "../fake/FakeBackend.ts"
import { scenarioFn } from "../state/atoms.ts"
import { appConfig } from "../state/runtime.ts"

const isScenario = (name: string): name is Scenario => Scenario.some((s) => s === name)

export function FixturesLaunch() {
  const router = useRouter()
  const run = useAtomSet(scenarioFn, { mode: "promiseExit" })
  const done = useRef(false)
  useEffect(() => {
    if (done.current || appConfig.backend !== "fixtures" || !DreamNative) return
    done.current = true
    const scenarios = (DreamNative.launchArgument("dreamScenario") ?? "").split(",").filter(isScenario)
    const route = DreamNative.launchArgument("dreamRoute")
    void scenarios
      .reduce<Promise<unknown>>((previous, name) => previous.then(() => run(name)), Promise.resolve())
      .then(() => {
        // A path inside this app, typed by whoever launched the Simulator.
        if (route?.startsWith("/")) setTimeout(() => router.replace(route as Href), 300)
      })
  }, [run, router])
  return null
}
