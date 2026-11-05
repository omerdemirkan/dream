/**
 * Fixtures mode: puts the sample world into named states, one after another.
 * Backend scenarios change the fake API; `live-activity…` starts a Live
 * Activity on this phone.
 */
import { useAtomSet } from "@effect/atom-react"
import { useCallback } from "react"
import { DreamNative } from "../../modules/dream-native/index.ts"
import { Scenario } from "../fake/FakeBackend.ts"
import { liveActivitySamples } from "../fake/fixtures.ts"
import { scenarioFn } from "../state/atoms.ts"
import { appConfig } from "../state/runtime.ts"

const isScenario = (name: string): name is Scenario => Scenario.some((s) => s === name)

export const parseScenarios = (value: string | null | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

export function useScenarios() {
  const run = useAtomSet(scenarioFn, { mode: "promiseExit" })
  return useCallback(
    async (names: ReadonlyArray<string>) => {
      if (appConfig.backend !== "fixtures") return
      for (const name of names) {
        const sample = liveActivitySamples[name]
        if (sample && DreamNative) {
          await DreamNative.endAll()
          await DreamNative.startLocal(JSON.stringify(sample.attributes), JSON.stringify(sample.content)).catch(
            () => ""
          )
        } else if (isScenario(name)) {
          await run(name)
        }
      }
    },
    [run]
  )
}
