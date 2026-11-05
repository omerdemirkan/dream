import { assert, describe, it } from "@effect/vitest"
import type { AgentEvent } from "@dream/domain"
import { Context, Effect, Layer, Ref } from "effect"
import { Api, type Report } from "../src/Api.ts"
import { PageCheck, PageLoad } from "../src/cli/PageCheck.ts"
import { Inbox } from "../src/Inbox.ts"
import { brokenKey, Published } from "../src/Published.ts"
import { baseLayer, tempDir } from "./support.ts"

const loaded = (fields: Partial<Omit<Extract<PageLoad, { _tag: "Loaded" }>, "_tag">> = {}) =>
  PageLoad.cases.Loaded.make({
    via: "browser",
    status: 200,
    contentType: "text/html",
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    stillLoading: false,
    ...fields
  })

const blocked = loaded({ status: 403, contentType: "text/plain", firstLine: "Blocked request." })
const crashed = loaded({
  title: "Habit Tracker",
  pageErrors: ["TypeError: Cannot read properties of undefined (reading 'pm2_5')"]
})

/** Published, backed by a page check that answers `loads` in order, and an inbox in `dir`. */
const setup = (dir: string, loads: Ref.Ref<ReadonlyArray<PageLoad>>) =>
  Effect.gen(function* () {
    const reports = yield* Ref.make<ReadonlyArray<Report>>([])
    const next = Ref.modify(loads, ([first, ...rest]) => [first ?? loaded(), rest])
    const context = yield* Layer.build(
      Published.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(Api.layerTest(reports), PageCheck.layerTest(next), Inbox.layer)),
        Layer.provideMerge(baseLayer(dir))
      )
    )
    const published = Context.get(context, Published)
    const inbox = Context.get(context, Inbox)
    /** Check, and return the facts of any events it queued, as a turn that handled them would. */
    const check = Effect.gen(function* () {
      yield* published.checkAfterTurn
      const events = yield* inbox.take
      yield* inbox.release(
        events.map((event) => event.id),
        "done"
      )
      return events.flatMap((event: AgentEvent) => (event._tag === "PublishedUrlBroken" ? [event.facts] : []))
    })
    return { published, check, reports }
  })

describe("the check after a turn", () => {
  it.effect("does nothing until a port is published", () =>
    Effect.gen(function* () {
      const loads = yield* Ref.make<ReadonlyArray<PageLoad>>([blocked])
      const { check, reports } = yield* setup(tempDir(), loads)
      assert.deepStrictEqual(yield* check, [])
      assert.deepStrictEqual(yield* Ref.get(reports), [])
      assert.strictEqual((yield* Ref.get(loads)).length, 1)
    }).pipe(Effect.scoped)
  )

  it.effect("tells the agent once per breakage, and again after it was healthy", () =>
    Effect.gen(function* () {
      const loads = yield* Ref.make<ReadonlyArray<PageLoad>>([blocked, blocked, crashed, loaded(), crashed])
      const { published, check, reports } = yield* setup(tempDir(), loads)
      yield* published.noted(5173)
      const [first, ...none] = yield* check
      assert.deepStrictEqual(none, [])
      assert.include(first, '403 text/plain, "Blocked request."')
      assert.deepStrictEqual(yield* check, [], "the same 403 again")
      const [changed] = yield* check
      assert.include(changed, "TypeError: Cannot read properties of undefined (reading 'pm2_5')")
      assert.deepStrictEqual(yield* check, [], "healthy")
      assert.strictEqual((yield* check).length, 1, "broken again after being healthy")
      assert.deepStrictEqual(
        (yield* Ref.get(reports)).map((report) => (report._tag === "Publish" ? report.port : report._tag)),
        [5173, 5173, 5173, 5173, 5173]
      )
    }).pipe(Effect.scoped)
  )

  it.effect("remembers what it reported across restarts", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const loads = yield* Ref.make<ReadonlyArray<PageLoad>>([blocked, blocked])
      const before = yield* setup(dir, loads)
      yield* before.published.noted(3000)
      assert.strictEqual((yield* before.check).length, 1)
      const after = yield* setup(dir, loads)
      assert.deepStrictEqual(yield* after.check, [])
      assert.deepStrictEqual(
        (yield* Ref.get(after.reports)).map((report) => report._tag === "Publish" && report.port),
        [3000]
      )
    }).pipe(Effect.scoped)
  )

  it("counts error statuses, page errors and no answer as broken, and nothing else", () => {
    assert.isDefined(brokenKey(blocked))
    assert.isDefined(brokenKey(crashed))
    assert.isDefined(
      brokenKey(PageLoad.cases.Unreachable.make({ via: "browser", message: "net::ERR_CONNECTION_REFUSED" }))
    )
    assert.isUndefined(brokenKey(loaded({ failedRequests: ["404 https://x/favicon.ico"], consoleErrors: ["warn"] })))
    assert.isUndefined(brokenKey(loaded({ stillLoading: true })))
    assert.strictEqual(
      brokenKey(loaded({ pageErrors: ["a", "b"], firstLine: "12:01" })),
      brokenKey(loaded({ pageErrors: ["b", "a"], firstLine: "12:02" }))
    )
  })
})
