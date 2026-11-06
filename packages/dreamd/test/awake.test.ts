import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Api, ApiError, type Report } from "../src/Api.ts"
import { AppTraffic, Awake, type PortTraffic, portTraffic } from "../src/Awake.ts"
import { Commands } from "../src/Commands.ts"
import { Published } from "../src/Published.ts"

// Port 3000 is 0BB8. A listener; through E2B's proxy (from 10.12.0.134), a request that just closed and an open
// WebSocket; a request from inside the sandbox (loopback), which doesn't count; and another port's traffic.
const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 1500FEA9:0BB8 86000C0A:D2F0 06 00000000:00000000 03:00001773 00000000     0        0 0 3 0000000000000000
   2: 0100007F:0BB8 0100007F:D2F2 06 00000000:00000000 03:00001773 00000000     0        0 0 3 0000000000000000
   3: 1500FEA9:1F90 86000C0A:D2F4 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 20 4 30 10 -1
`
const tcp6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0000000000000000FFFF00001500FEA9:0BB8 0000000000000000FFFF000086000C0A:EAC4 01 00000000:00000000 00:00000000 00000000  1001        0 1697 1 0000000053bf00c4 20 4 31 10 -1
   1: 00000000000000000000000001000000:0BB8 00000000000000000000000001000000:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1
   2: 0000000000000000FFFF00000100007F:0BB8 0000000000000000FFFF00000100007F:9C44 06 00000000:00000000 03:00001773 00000000     0        0 0 3 0000000000000000
`

describe("the published port's traffic", () => {
  it("counts connections from outside to that port, open and recently closed, over IPv4 and IPv6", () => {
    const traffic = portTraffic([tcp, tcp6], 3000)
    assert.deepStrictEqual([...traffic.open], ["0000000000000000FFFF000086000C0A:EAC4"])
    assert.strictEqual(traffic.recentlyClosed, 1)
    assert.deepStrictEqual(portTraffic([tcp], 8080), { open: new Set(["86000C0A:D2F4"]), recentlyClosed: 0 })
    assert.deepStrictEqual(portTraffic([""], 3000), { open: new Set<string>(), recentlyClosed: 0 })
  })
})

const quiet: PortTraffic = { open: new Set<string>(), recentlyClosed: 0 }

const setup = (options: { readonly api?: Layer.Layer<Api> } = {}) =>
  Effect.gen(function* () {
    const reports = yield* Ref.make<ReadonlyArray<Report>>([])
    const busy = yield* Ref.make(false)
    const port = yield* Ref.make(Option.none<number>())
    const traffic = yield* Ref.make(quiet)
    const context = yield* Layer.build(
      Awake.layer.pipe(
        Layer.provide([
          options.api ?? Api.layerTest(reports),
          Layer.succeed(Commands, Commands.of({ run: Effect.never, busy: Ref.get(busy) })),
          Layer.succeed(
            Published,
            Published.of({ port: Ref.get(port), noted: () => Effect.void, checkAfterTurn: Effect.void })
          ),
          AppTraffic.layerTest(traffic)
        ])
      )
    )
    const fiber = yield* Effect.forkScoped(Context.get(context, Awake).run)
    const asked = Effect.map(Ref.get(reports), (all) =>
      all.flatMap((report) => (report._tag === "StayAwake" ? [report.reason] : []))
    )
    /** Let time pass, a look at a time, so every look runs. */
    const pass = (minutes: number) =>
      Effect.gen(function* () {
        for (let i = 0; i < minutes * 2; i++) yield* TestClock.adjust("30 seconds")
      })
    yield* Effect.yieldNow
    return { busy, port, traffic, asked, pass, fiber }
  })

describe("staying awake", () => {
  it.effect("asks about once a minute while a scheduled command runs, and stops when it's done", () =>
    Effect.gen(function* () {
      const { busy, asked, pass } = yield* setup()
      yield* pass(3)
      assert.deepStrictEqual(yield* asked, [])
      yield* Ref.set(busy, true)
      yield* pass(0.5)
      assert.deepStrictEqual(yield* asked, ["command"])
      yield* pass(0.5)
      assert.deepStrictEqual(yield* asked, ["command"])
      yield* pass(3)
      assert.lengthOf(yield* asked, 4)
      // The last look while it ran is still answered, then nothing.
      yield* Ref.set(busy, false)
      yield* pass(1)
      assert.lengthOf(yield* asked, 5)
      yield* pass(5)
      assert.lengthOf(yield* asked, 5)
    }).pipe(Effect.scoped)
  )

  it.effect("keeps asking while the app gets requests, and a quiet open connection counts for two hours", () =>
    Effect.gen(function* () {
      const { port, traffic, asked, pass } = yield* setup()
      // Nothing is published: its traffic isn't looked at.
      yield* Ref.set(traffic, { open: new Set<string>(), recentlyClosed: 1 })
      yield* pass(2)
      assert.deepStrictEqual(yield* asked, [])

      yield* Ref.set(port, Option.some(3000))
      yield* pass(10)
      const whileRequested = (yield* asked).length
      assert.isAtLeast(whileRequested, 9)
      assert.isTrue((yield* asked).every((reason) => reason === "app"))

      // Requests stop, and a WebSocket stays open: it counts for two hours from the last request, then not.
      yield* Ref.set(traffic, { open: new Set(["ws"]), recentlyClosed: 0 })
      yield* pass(115)
      const whileOpen = (yield* asked).length
      assert.isAtLeast(whileOpen - whileRequested, 110)
      yield* pass(30)
      const capped = (yield* asked).length
      assert.isAtMost(capped - whileOpen, 6)
      yield* pass(30)
      assert.strictEqual((yield* asked).length, capped)

      // A new connection is a new request.
      yield* Ref.set(traffic, { open: new Set(["ws", "ws-2"]), recentlyClosed: 0 })
      yield* pass(1)
      assert.isAbove((yield* asked).length, capped)

      yield* Ref.set(traffic, quiet)
      const after = (yield* asked).length
      yield* pass(10)
      assert.isAtMost((yield* asked).length - after, 1)
    }).pipe(Effect.scoped)
  )

  it.effect("carries on, asking no more often, when the API doesn't know StayAwake", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const refusing = Layer.succeed(Api, {
        ...Context.get(yield* Layer.build(Api.layerTest(yield* Ref.make<ReadonlyArray<Report>>([]))), Api),
        stayAwake: () =>
          Ref.update(calls, (n) => n + 1).pipe(
            Effect.andThen(Effect.fail(new ApiError({ message: "Unknown request tag: StayAwake" })))
          )
      })
      const { busy, pass, fiber } = yield* setup({ api: refusing })
      yield* Ref.set(busy, true)
      yield* pass(10)
      const made = yield* Ref.get(calls)
      assert.isAtLeast(made, 9)
      assert.isAtMost(made, 11)
      assert.isUndefined(fiber.pollUnsafe())
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.scoped)
  )
})
