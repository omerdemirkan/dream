import { assert, describe, it } from "@effect/vitest"
import { Clock, Context, DateTime, Deferred, Duration, Effect, Layer, Queue, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Agent, backoff } from "../src/Agent.ts"
import { Api, type Report } from "../src/Api.ts"
import { Harness, type HarnessError, type TurnResult, TurnOutcome } from "../src/harness/Harness.ts"
import { Inbox } from "../src/Inbox.ts"
import { baseLayer, tempDir, usageReset, userMessage } from "./support.ts"

type Script = (prompt: string) => Effect.Effect<TurnResult, HarnessError>

const completed = (progressed = true): TurnResult => ({ outcome: TurnOutcome.Completed(), usage: {}, progressed })

const setup = (options: { readonly steerable?: boolean } = {}) =>
  Effect.gen(function* () {
    const turns = yield* Queue.unbounded<Script>()
    const log = yield* Ref.make<ReadonlyArray<string>>([])
    const reports = yield* Ref.make<ReadonlyArray<Report>>([])
    const layer = Agent.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Harness.layerTest({
            turns,
            log,
            ...(options.steerable === undefined ? {} : { steerable: options.steerable })
          }),
          Api.layerTest(reports)
        )
      ),
      Layer.provideMerge(Inbox.layer),
      Layer.provideMerge(baseLayer(tempDir()))
    )
    const context = yield* Layer.build(layer)
    const inbox = Context.get(context, Inbox)
    const agent = Context.get(context, Agent)
    yield* Effect.forkScoped(agent.run)
    /** Wait until the scripted harness has recorded `n` entries. */
    const logged = (n: number) =>
      Effect.gen(function* () {
        while ((yield* Ref.get(log)).length < n) yield* Effect.yieldNow
        return yield* Ref.get(log)
      })
    const idle = Effect.gen(function* () {
      while (true) {
        const status = yield* agent.status
        if (status.turn === "idle") return
        yield* Effect.yieldNow
      }
    })
    return { turns, log, reports, inbox, agent, logged, idle }
  })

describe("Agent", () => {
  it.effect("runs a turn with what was queued and reports it", () =>
    Effect.gen(function* () {
      const { turns, inbox, logged, reports, idle } = yield* setup()
      yield* Queue.offer(turns, () => Effect.succeed(completed()))
      yield* inbox.deliver([userMessage(1, "Make the charts bigger")], "America/Los_Angeles")
      const [entry] = yield* logged(1)
      assert.include(entry, "What woke you:")
      assert.include(entry, "> Make the charts bigger")
      assert.include(entry, "(America/Los_Angeles)")
      yield* idle
      while ((yield* Ref.get(reports)).length < 2) yield* Effect.yieldNow
      assert.deepStrictEqual(
        (yield* Ref.get(reports)).map((report) =>
          report._tag === "Turn" ? `${report.state} ${report.eventIds}` : "usage"
        ),
        ["started evt_1", "finished evt_1"]
      )
      assert.strictEqual((yield* inbox.state).entries.length, 0)
    }).pipe(Effect.scoped)
  )

  it.effect("hands events that arrive mid-turn to the running turn", () =>
    Effect.gen(function* () {
      const { turns, inbox, logged, reports, idle } = yield* setup()
      const release = yield* Deferred.make<void>()
      yield* Queue.offer(turns, () => Deferred.await(release).pipe(Effect.as(completed())))
      yield* inbox.deliver([userMessage(1)])
      yield* logged(1)
      yield* inbox.deliver([userMessage(2, "Also dark mode")])
      const log = yield* logged(2)
      assert.include(log[1], "steer: ")
      assert.include(log[1], "This arrived while you were working:")
      assert.include(log[1], "> Also dark mode")
      yield* Deferred.succeed(release, undefined)
      yield* idle
      while (!(yield* Ref.get(reports)).some((report) => report._tag === "Turn" && report.state === "finished")) {
        yield* Effect.yieldNow
      }
      const finished = (yield* Ref.get(reports)).find((report) => report._tag === "Turn" && report.state === "finished")
      assert.deepStrictEqual<ReadonlyArray<string>>(finished?._tag === "Turn" ? finished.eventIds : [], [
        "evt_1",
        "evt_2"
      ])
      assert.strictEqual((yield* inbox.state).entries.length, 0)
    }).pipe(Effect.scoped)
  )

  it.effect("starts another turn when the running one can't take new events", () =>
    Effect.gen(function* () {
      const { turns, inbox, logged } = yield* setup({ steerable: false })
      const release = yield* Deferred.make<void>()
      yield* Queue.offer(turns, () => Deferred.await(release).pipe(Effect.as(completed())))
      yield* Queue.offer(turns, () => Effect.succeed(completed()))
      yield* inbox.deliver([userMessage(1)])
      yield* logged(1)
      yield* inbox.deliver([userMessage(2, "Also dark mode")])
      yield* Deferred.succeed(release, undefined)
      const log = yield* logged(2)
      assert.include(log[1], "turn: ")
      assert.include(log[1], "> Also dark mode")
    }).pipe(Effect.scoped)
  )

  it.effect("retries a turn that failed before doing anything, after a backoff", () =>
    Effect.gen(function* () {
      const { turns, inbox, log, logged } = yield* setup()
      yield* Queue.offer(turns, () =>
        Effect.succeed({ outcome: TurnOutcome.Failed({ message: "401" }), usage: {}, progressed: false })
      )
      yield* Queue.offer(turns, () => Effect.succeed(completed()))
      yield* inbox.deliver([userMessage(1, "hello")])
      yield* logged(1)
      // The loop sleeps for the backoff after recording the failure; move the clock until it has.
      while ((yield* Ref.get(log)).length < 2) {
        yield* TestClock.adjust("1 second")
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2)))
      }
      assert.isAtLeast(yield* Clock.currentTimeMillis, Duration.toMillis(backoff(1)))
      assert.include((yield* Ref.get(log))[1], "> hello")
    }).pipe(Effect.scoped)
  )

  it.effect("stops at a usage limit and waits for the reset", () =>
    Effect.gen(function* () {
      const { turns, inbox, log, logged, reports } = yield* setup()
      const until = DateTime.add(yield* DateTime.now, { hours: 2 })
      yield* Queue.offer(turns, () =>
        Effect.succeed({
          outcome: TurnOutcome.Failed({ message: "limit" }),
          usage: { fiveHour: { usedPercent: 100 }, limit: { window: "fiveHour" as const, until } },
          progressed: true
        })
      )
      yield* Queue.offer(turns, () => Effect.succeed(completed()))
      yield* inbox.deliver([userMessage(1)])
      yield* logged(1)
      while (!(yield* Ref.get(reports)).some((report) => report._tag === "Usage")) yield* Effect.yieldNow
      const usage = (yield* Ref.get(reports)).find((report) => report._tag === "Usage")
      assert.strictEqual(
        usage?._tag === "Usage" && usage.usage.limitedUntil && DateTime.formatIso(usage.usage.limitedUntil.until),
        DateTime.formatIso(until)
      )

      // A message during the limit waits…
      yield* inbox.deliver([userMessage(2, "still there?")])
      yield* TestClock.adjust("1 hour")
      assert.strictEqual((yield* Ref.get(log)).length, 1)
      // …until the reset arrives.
      yield* inbox.deliver([usageReset(3)])
      const after = yield* logged(2)
      assert.include(after[1], "> still there?")
      assert.include(after[1], "Their five-hour usage window has reset.")
    }).pipe(Effect.scoped)
  )
})
