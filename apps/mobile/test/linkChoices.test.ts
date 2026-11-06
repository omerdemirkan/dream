/** What the add sheet over Home's app links offers, and why it's empty when it is. */
import type { AppLink, LinkId } from "@dream/domain"
import * as Fixtures from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { linkChoices } from "../src/data/linkChoices.ts"

const [liftLog, brief, cabin, train] = Fixtures.links as [AppLink, AppLink, AppLink, AppLink]
const removed = (link: AppLink, iso: string, changes: Partial<AppLink> = {}): AppLink => ({
  ...link,
  ...changes,
  removedAt: DateTime.makeUnsafe(iso)
})

describe("link choices", () => {
  it("offers the agents' links they removed, in the order given (most recently removed first)", () => {
    const timer = removed(liftLog, "2026-11-05T10:00:00Z", { id: "lnk_timer" as LinkId, url: `${liftLog.url}/timer` })
    const gone = removed(brief, "2026-11-04T10:00:00Z")
    assert.deepStrictEqual(linkChoices([liftLog, cabin, train], [timer, gone]), {
      _tag: "Choices",
      links: [timer, gone]
    })
  })

  it("leaves out what's on Home already, by address, and offers one address once", () => {
    const gone = removed(brief, "2026-11-04T10:00:00Z")
    const sameAgain = removed(brief, "2026-11-01T10:00:00Z", { id: "lnk_brief2" as LinkId, url: `${brief.url}/` })
    const handAdded: AppLink = { ...train, id: "lnk_mine" as LinkId, url: `${brief.url}/` }
    assert.deepStrictEqual(linkChoices([liftLog], [gone, sameAgain]), { _tag: "Choices", links: [gone] })
    assert.deepStrictEqual(linkChoices([liftLog, handAdded], [gone, sameAgain]), { _tag: "AllOnHome" })
  })

  it("never offers a link they added themselves", () => {
    assert.deepStrictEqual(linkChoices([], [removed(train, "2026-11-04T10:00:00Z")]), { _tag: "NothingYet" })
  })

  it("is empty because nothing's been made yet, or because everything is on Home", () => {
    assert.deepStrictEqual(linkChoices([], []), { _tag: "NothingYet" })
    assert.deepStrictEqual(linkChoices([train], []), { _tag: "NothingYet" })
    assert.deepStrictEqual(linkChoices([liftLog, train], []), { _tag: "AllOnHome" })
  })
})
