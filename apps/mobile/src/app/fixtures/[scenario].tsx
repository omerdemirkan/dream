/**
 * Fixtures mode only: dream://fixtures/<scenario>[,<scenario>…][?to=/path] puts
 * the sample world in named states, then opens `to` (Home by default). Used to
 * reach every screen state from a link when checking the app.
 */
import { type Href, Redirect, useLocalSearchParams } from "expo-router"
import { useEffect, useState } from "react"
import { parseScenarios, useScenarios } from "../../ui/useScenarios.ts"

export default function FixtureScenario() {
  const params = useLocalSearchParams<{ scenario: string; to?: string }>()
  const scenarios = useScenarios()
  const [done, setDone] = useState(false)
  useEffect(() => {
    void scenarios(parseScenarios(params.scenario)).finally(() => setDone(true))
  }, [params.scenario, scenarios])
  if (!done) return null
  const to = params.to?.startsWith("/") ? params.to : "/"
  // `to` is a path inside this app, from a link the developer typed.
  return <Redirect href={to as Href} />
}
