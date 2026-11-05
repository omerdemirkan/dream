import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Inbox, maxAttempts, queuedCount } from "../src/Inbox.ts"
import { baseLayer, tempDir, userMessage, wakeWithCommand } from "./support.ts"

/** A fresh Inbox over `dir`, as dreamd would build it after a (re)start. */
const inboxAt = (dir: string) => Inbox.layer.pipe(Layer.provideMerge(baseLayer(dir)))
const withInbox = <A, E>(dir: string, f: (inbox: Inbox["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* f(yield* Inbox)
  }).pipe(Effect.provide(inboxAt(dir)))

describe("Inbox", () => {
  it.effect("persists deliveries before replying, and ignores redeliveries", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const accepted = yield* withInbox(dir, (inbox) =>
        inbox.deliver([userMessage(1), userMessage(2)], "Europe/Berlin")
      )
      assert.deepStrictEqual<ReadonlyArray<string>>(accepted, ["evt_1", "evt_2"])

      // A new process sees the same inbox; a redelivery is accepted but not queued twice.
      const state = yield* withInbox(dir, (inbox) =>
        inbox.deliver([userMessage(2), userMessage(3)]).pipe(Effect.andThen(inbox.state))
      )
      assert.deepStrictEqual(
        state.entries.map((entry) => entry.event.id),
        ["evt_1", "evt_2", "evt_3"]
      )
      assert.strictEqual(state.timeZone, "Europe/Berlin")
      assert.strictEqual(queuedCount(state), 3)
    })
  )

  it.effect("hands queued events to a turn and drops them when it ends", () =>
    withInbox(tempDir(), (inbox) =>
      Effect.gen(function* () {
        yield* inbox.deliver([userMessage(1)])
        const taken = yield* inbox.take
        assert.deepStrictEqual(
          taken.map((event) => event.id),
          ["evt_1"]
        )
        assert.strictEqual((yield* inbox.take).length, 0)
        yield* inbox.deliver([userMessage(2)])
        yield* inbox.release(["evt_1" as never], "done")
        const state = yield* inbox.state
        assert.deepStrictEqual(
          state.entries.map((entry) => [entry.event.id, entry.state]),
          [["evt_2", "queued"]]
        )
      })
    )
  )

  it.effect("queues a failed turn's events again, until they've failed too often", () =>
    withInbox(tempDir(), (inbox) =>
      Effect.gen(function* () {
        yield* inbox.deliver([userMessage(1)])
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const taken = yield* inbox.take
          assert.strictEqual(taken.length, 1)
          yield* inbox.release(["evt_1" as never], "retry")
        }
        assert.strictEqual((yield* inbox.state).entries.length, 0)
      })
    )
  )

  it.effect("gives events a crashed turn had taken to the next turn", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      yield* withInbox(dir, (inbox) => inbox.deliver([userMessage(1)]).pipe(Effect.andThen(inbox.take)))
      const retaken = yield* withInbox(dir, (inbox) => inbox.take)
      assert.deepStrictEqual(
        retaken.map((event) => event.id),
        ["evt_1"]
      )
    })
  )

  it.effect("runs scheduled commands before the agent sees them", () =>
    withInbox(tempDir(), (inbox) =>
      Effect.gen(function* () {
        yield* inbox.deliver([wakeWithCommand(1, "true"), wakeWithCommand(2, "false")])
        assert.strictEqual((yield* inbox.take).length, 0)
        assert.deepStrictEqual(
          (yield* inbox.commands).map((event) => event.id),
          ["evt_1", "evt_2"]
        )
        yield* inbox.commandFinished("evt_1" as never, { exitCode: 0, outputTail: "ok" })
        yield* inbox.commandFinished("evt_2" as never, { exitCode: 1, outputTail: "boom" })
        const taken = yield* inbox.take
        assert.strictEqual(taken.length, 1)
        const [failed] = taken
        assert.strictEqual(failed?._tag === "WakeDue" && failed.run?.result?.outputTail, "boom")
      })
    )
  )
})
