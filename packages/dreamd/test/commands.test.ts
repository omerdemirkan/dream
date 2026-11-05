import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Stream } from "effect"
import { Commands } from "../src/Commands.ts"
import { Inbox } from "../src/Inbox.ts"
import { baseLayer, tempDir, wakeWithCommand } from "./support.ts"

describe("scheduled commands", () => {
  it.live("drop a wake whose command succeeds, and queue one that fails with its output", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Commands.layer.pipe(Layer.provideMerge(Inbox.layer), Layer.provideMerge(baseLayer(tempDir())))
      )
      const inbox = Context.get(context, Inbox)
      yield* Effect.forkScoped(Context.get(context, Commands).run)
      yield* inbox.deliver([
        wakeWithCommand(1, "echo fine"),
        wakeWithCommand(2, "echo 'parser failed on 3 issues' >&2; exit 3")
      ])
      const state = yield* inbox.changes.pipe(
        Stream.filter((state) => state.entries.every((entry) => entry.state !== "command")),
        Stream.runHead,
        Effect.timeout("10 seconds")
      )
      const entries = state._tag === "Some" ? state.value.entries : []
      assert.strictEqual(entries.length, 1)
      const [failed] = entries
      assert.strictEqual(failed?.state, "queued")
      const result = failed?.event._tag === "WakeDue" ? failed.event.run?.result : undefined
      assert.strictEqual(result?.exitCode, 3)
      assert.include(result?.outputTail, "parser failed on 3 issues")
    }).pipe(Effect.scoped)
  )
})
