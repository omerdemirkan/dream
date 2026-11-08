/**
 * The operator's view (`AccountCosts.everyone`, only for `DREAM_OPERATORS`): everything Dream paid this month, each
 * person's share, and the overhead no one caused (template builds, checks, refresh donors). Reached from the foot of
 * the costs detail, so no one else ever sees the way in.
 */
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ActivityIndicator, Text } from "react-native"
import { everyoneView } from "../../data/costs.ts"
import { accountCostsAtom } from "../../state/atoms.ts"
import { CostRow, DayChart, ShareCostRow, Total } from "../../ui/Costs.tsx"
import { color } from "../../ui/theme.ts"
import { Footnote, SectionHeading } from "../../ui/Usage.tsx"
import { DetailScreen } from "../../ui/DetailScreen.tsx"

export default function EveryoneCosts() {
  const result = useAtomValue(accountCostsAtom)
  const everyone = Option.getOrUndefined(AsyncResult.value(result))?.everyone
  const view = everyone ? everyoneView(everyone) : undefined
  return (
    <DetailScreen title="Everyone">
      {view ? (
        <>
          <Total total={view.total} size={34} />
          <Text style={{ fontSize: 14, color: color.t2 }}>{view.caption}</Text>
          <DayChart days={view.days} />
          <SectionHeading>What it paid for</SectionHeading>
          {view.rows.map((row) => (
            <CostRow key={row.key} row={row} nested />
          ))}
          <SectionHeading>People</SectionHeading>
          {view.people.map((p) => (
            <ShareCostRow key={p.key} row={p} tile={false} />
          ))}
          {view.overhead.length > 0 ? (
            <>
              <SectionHeading>{`Builds, checks and throwaway sandboxes, ${view.overheadTotal}`}</SectionHeading>
              {view.overhead.map((row) => (
                <CostRow key={row.key} row={row} nested={false} />
              ))}
            </>
          ) : null}
          <Footnote>Estimates. Cloudflare and plan fees aren’t counted.</Footnote>
        </>
      ) : AsyncResult.isInitial(result) || result.waiting ? (
        <ActivityIndicator color={color.t3} style={{ marginTop: 40 }} />
      ) : (
        <Text style={{ fontSize: 14.5, color: color.t2, marginTop: 16 }}>Costs aren’t available right now.</Text>
      )}
    </DetailScreen>
  )
}
