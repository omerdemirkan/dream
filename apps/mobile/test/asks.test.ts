import type { Message, MessageId } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { cabinHold, cabinPick, cabinRule, calendarAccess, mockNow } from "../src/fake/fixtures.ts"
import { needsThem, nextOpenAsk } from "../src/ui/asks.ts"

const hold = cabinHold(cabinPick.projectId, mockNow)
const answered = (m: typeof cabinPick): Message => ({
  ...m,
  state: { _tag: "Answered", answer: { _tag: "Choice", option: m.options[0] ?? "" }, answeredAt: mockNow }
})
const id = (m: Message | undefined) => m?.id as MessageId | undefined

describe("next open ask", () => {
  const series: ReadonlyArray<Message> = [cabinRule, cabinPick, calendarAccess, hold]

  it("moves on in order, questions and access requests alike", () => {
    assert.strictEqual(id(nextOpenAsk(series, cabinRule.id, { wrap: true })), cabinPick.id)
    assert.strictEqual(id(nextOpenAsk(series, cabinPick.id, { wrap: true })), calendarAccess.id)
    assert.strictEqual(id(nextOpenAsk(series, calendarAccess.id, { wrap: true })), hold.id)
  })

  it("skips answered asks, later access requests and ones passed on the way", () => {
    const later = { ...calendarAccess, when: "after the first booking" }
    assert.strictEqual(
      id(nextOpenAsk([cabinRule, answered(cabinPick), later, hold], cabinRule.id, { wrap: true })),
      hold.id
    )
    assert.isFalse(needsThem(later))
    assert.strictEqual(
      id(nextOpenAsk(series, calendarAccess.id, { passed: [hold.id, cabinRule.id], wrap: true })),
      cabinPick.id
    )
  })

  it("wraps to an earlier one only when asked, and ends when none are left", () => {
    assert.strictEqual(id(nextOpenAsk(series, hold.id, { wrap: true })), cabinRule.id)
    assert.isUndefined(nextOpenAsk(series, hold.id, { wrap: false }))
    assert.isUndefined(nextOpenAsk([answered(cabinRule), answered(cabinPick), hold], hold.id, { wrap: true }))
  })
})
