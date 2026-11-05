/**
 * Fixtures mode only: dream://fixtures/<scenario>[?to=/path] puts the sample
 * world in a named state, then opens `to` (Home by default). Used to reach
 * every screen state from a link when checking the app.
 */
import { liveActivitySamples } from "../../fake/fixtures.ts"
import { useAtomSet } from "@effect/atom-react"
import { Redirect, type Href, useLocalSearchParams } from "expo-router"
import { useEffect, useState } from "react"
import { Scenario } from "../../fake/FakeBackend.ts"
import { scenarioFn } from "../../state/atoms.ts"
import { appConfig } from "../../state/runtime.ts"
import { DreamLiveActivity } from "../../../modules/dream-live-activity/index.ts"

const isScenario = (name: string | undefined): name is Scenario => Scenario.some((s) => s === name)

export default function FixtureScenario() {
  const params = useLocalSearchParams<{ scenario: string; to?: string }>()
  const run = useAtomSet(scenarioFn, { mode: "promiseExit" })
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (appConfig.backend !== "fixtures") return setDone(true)
    const sample = liveActivitySamples[params.scenario]
    if (sample && DreamLiveActivity) {
      // Shows the widget on the lock screen and in the Dynamic Island.
      void DreamLiveActivity.endAll()
        .then(() => DreamLiveActivity?.startLocal(JSON.stringify(sample.attributes), JSON.stringify(sample.content)))
        .finally(() => setDone(true))
      return
    }
    if (!isScenario(params.scenario)) return setDone(true)
    void run(params.scenario).then(() => setDone(true))
  }, [params.scenario, run])
  if (!done) return null
  const to = params.to && params.to.startsWith("/") ? params.to : "/"
  // `to` is a path inside this app, from a link the developer typed.
  return <Redirect href={to as Href} />
}
