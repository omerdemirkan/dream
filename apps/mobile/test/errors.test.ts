import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describeError, RequestTimedOut, withWriteTimeout, writeTimeout } from "../src/data/errors.ts"

describe("write timeouts", () => {
  it.effect("a write that hangs fails with RequestTimedOut once the limit passes", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.never.pipe(withWriteTimeout, Effect.forkChild)
      yield* TestClock.adjust("24 seconds")
      assert.isUndefined(fiber.pollUnsafe())
      yield* TestClock.adjust(writeTimeout)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
      assert.strictEqual(error?._tag === "Fail" ? error.error._tag : undefined, "RequestTimedOut")
    })
  )

  it.effect("a write that finishes in time is untouched", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.succeed("sent").pipe(Effect.delay("3 seconds"), withWriteTimeout, Effect.forkChild)
      yield* TestClock.adjust("3 seconds")
      assert.strictEqual(yield* Fiber.join(fiber), "sent")
    })
  )

  it("says so in plain words", () => {
    assert.match(describeError(new RequestTimedOut()), /didn't go through/)
  })
})
