import { assert, describe, it } from "@effect/vitest"
import { Clock, Context, Effect, Fiber, Layer, Option, PubSub, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "../src/Agent.ts"
import { Api, ApiError, type Report } from "../src/Api.ts"
import {
  AppTraffic,
  Awake,
  nothingLeft,
  type PortTraffic,
  portTraffic,
  type SleepCheck,
  sleepVerdict
} from "../src/Awake.ts"
import { Commands } from "../src/Commands.ts"
import { noSelfCheck, Published, type SelfCheck } from "../src/Published.ts"
import { RelayForwarder } from "../src/Relays.ts"

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
    const pendingCommands = yield* Ref.make(0)
    const commandDone = yield* PubSub.unbounded<void>()
    const delivering = yield* Ref.make(false)
    const deliveryDone = yield* PubSub.unbounded<void>()
    const turn = yield* Ref.make<"idle" | "running">("idle")
    const queued = yield* Ref.make(0)
    const lastTurnEnded = yield* Ref.make(Option.none<number>())
    const port = yield* Ref.make(Option.none<number>())
    const traffic = yield* Ref.make(quiet)
    const self = yield* Ref.make<SelfCheck>(noSelfCheck)
    const context = yield* Layer.build(
      Awake.layer.pipe(
        Layer.provide([
          options.api ?? Api.layerTest(reports),
          Layer.succeed(
            Commands,
            Commands.of({
              run: Effect.never,
              busy: Ref.get(busy),
              pending: Ref.get(pendingCommands),
              finished: Stream.fromPubSub(commandDone)
            })
          ),
          Layer.succeed(
            RelayForwarder,
            RelayForwarder.of({
              forward: () => Effect.die("not in these tests"),
              busy: Ref.get(delivering),
              finished: Stream.fromPubSub(deliveryDone)
            })
          ),
          Layer.succeed(
            Agent,
            Agent.of({
              run: Effect.never,
              status: Effect.all({ turn: Ref.get(turn), queued: Ref.get(queued) }),
              lastTurnEnded: Ref.get(lastTurnEnded)
            })
          ),
          Layer.succeed(
            Published,
            Published.of({
              port: Ref.get(port),
              noted: () => Effect.void,
              checkAfterTurn: Effect.void,
              selfCheck: Ref.get(self)
            })
          ),
          AppTraffic.layerTest(traffic)
        ])
      )
    )
    const fiber = yield* Effect.forkScoped(Context.get(context, Awake).run)
    const asked = Effect.map(Ref.get(reports), (all) =>
      all.flatMap((report) => (report._tag === "StayAwake" ? [report.reason] : []))
    )
    const sleeps = Effect.map(Ref.get(reports), (all) =>
      all.flatMap((report) => (report._tag === "Sleep" ? [report.reason] : []))
    )
    /** Let time pass, a look at a time, so every look runs. */
    const pass = (minutes: number) =>
      Effect.gen(function* () {
        for (let i = 0; i < minutes * 2; i++) yield* TestClock.adjust("30 seconds")
      })
    /** Let a few seconds pass, a second at a time. */
    const seconds = (n: number) =>
      Effect.gen(function* () {
        for (let i = 0; i < n; i++) yield* TestClock.adjust("1 second")
      })
    /** A scheduled command runs for `forSeconds`, then finishes. */
    const runCommand = (forSeconds: number) =>
      Effect.gen(function* () {
        yield* Ref.set(busy, true)
        yield* Ref.set(pendingCommands, 1)
        yield* seconds(forSeconds)
        yield* Ref.set(busy, false)
        yield* Ref.set(pendingCommands, 0)
        yield* PubSub.publish(commandDone, undefined)
      })
    yield* Effect.yieldNow
    return {
      busy,
      pendingCommands,
      delivering,
      deliveryDone,
      turn,
      queued,
      lastTurnEnded,
      port,
      traffic,
      self,
      asked,
      sleeps,
      pass,
      seconds,
      runCommand,
      fiber
    }
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

  it.effect("keeps asking while the app gets requests, and a quiet open connection counts for twenty minutes", () =>
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

      // Requests stop, and a WebSocket stays open: it counts for twenty minutes from the last request, then not.
      yield* Ref.set(traffic, { open: new Set(["ws"]), recentlyClosed: 0 })
      yield* pass(18)
      const whileOpen = (yield* asked).length
      assert.isAtLeast(whileOpen - whileRequested, 16)
      yield* pass(5)
      const capped = (yield* asked).length
      assert.isAtMost(capped - whileOpen, 3)
      yield* pass(10)
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

const idle: SleepCheck = {
  commandRunning: false,
  commandsPending: 0,
  relayDelivering: false,
  turnRunning: false,
  queued: 0,
  appInUse: false,
  lastAppUseMs: undefined,
  lastTurnEndedMs: undefined,
  nowMs: 60 * 60_000
}

describe("whether anything is left", () => {
  it("is nothing only when no work runs or waits and nobody used the app or the agent lately", () => {
    assert.isTrue(nothingLeft(idle))
    assert.isFalse(nothingLeft({ ...idle, commandRunning: true }))
    assert.isFalse(nothingLeft({ ...idle, commandsPending: 1 }))
    assert.isFalse(nothingLeft({ ...idle, relayDelivering: true }))
    assert.isFalse(nothingLeft({ ...idle, turnRunning: true }))
    assert.isFalse(nothingLeft({ ...idle, queued: 2 }))
    assert.isFalse(nothingLeft({ ...idle, appInUse: true }))
    // The app's last request seen within half a minute, or a turn ended within 100 s: not yet.
    assert.isFalse(nothingLeft({ ...idle, lastAppUseMs: idle.nowMs - 20_000 }))
    assert.isTrue(nothingLeft({ ...idle, lastAppUseMs: idle.nowMs - 31_000 }))
    assert.isFalse(nothingLeft({ ...idle, lastTurnEndedMs: idle.nowMs - 60_000 }))
    assert.isTrue(nothingLeft({ ...idle, lastTurnEndedMs: idle.nowMs - 101_000 }))
  })

  it("waits when only time stands in the way, and drops the ask when there's work", () => {
    assert.strictEqual(sleepVerdict(idle), "now")
    assert.strictEqual(sleepVerdict({ ...idle, lastAppUseMs: idle.nowMs - 20_000 }), "wait")
    assert.strictEqual(sleepVerdict({ ...idle, lastTurnEndedMs: idle.nowMs - 60_000 }), "wait")
    assert.strictEqual(sleepVerdict({ ...idle, appInUse: true }), "drop")
    assert.strictEqual(sleepVerdict({ ...idle, turnRunning: true, lastTurnEndedMs: idle.nowMs - 60_000 }), "drop")
  })
})

describe("going back to sleep", () => {
  it.effect("asks to sleep a few seconds after the scheduled command it woke for is done", () =>
    Effect.gen(function* () {
      const { runCommand, sleeps, seconds } = yield* setup()
      yield* runCommand(3)
      yield* seconds(4)
      assert.deepStrictEqual(yield* sleeps, [])
      yield* seconds(2)
      assert.deepStrictEqual(yield* sleeps, ["command"])
      // Once per stretch of work: nothing more until something else runs.
      yield* seconds(120)
      assert.deepStrictEqual(yield* sleeps, ["command"])
      yield* runCommand(1)
      yield* seconds(6)
      assert.deepStrictEqual(yield* sleeps, ["command", "command"])
    }).pipe(Effect.scoped)
  )

  it.effect("asks after a relay delivery too, and waits for a burst of them to end", () =>
    Effect.gen(function* () {
      const { deliveryDone, delivering, sleeps, seconds } = yield* setup()
      for (let i = 0; i < 3; i++) {
        yield* Ref.set(delivering, true)
        yield* seconds(1)
        yield* Ref.set(delivering, false)
        yield* PubSub.publish(deliveryDone, undefined)
        yield* seconds(2)
      }
      assert.deepStrictEqual(yield* sleeps, [])
      yield* seconds(4)
      assert.deepStrictEqual(yield* sleeps, ["relay"])
    }).pipe(Effect.scoped)
  )

  it.effect("doesn't ask while a turn runs or waits, or when the command failed and woke the agent", () =>
    Effect.gen(function* () {
      const { runCommand, sleeps, seconds, turn, queued } = yield* setup()
      yield* Ref.set(turn, "running")
      yield* runCommand(1)
      yield* seconds(10)
      assert.deepStrictEqual(yield* sleeps, [])
      yield* Ref.set(turn, "idle")
      // A failed command queues an event for the agent before it counts as finished.
      yield* Ref.set(queued, 1)
      yield* runCommand(1)
      yield* seconds(10)
      assert.deepStrictEqual(yield* sleeps, [])
    }).pipe(Effect.scoped)
  )

  it.effect("waits out a turn that just ended, then asks", () =>
    Effect.gen(function* () {
      const { runCommand, sleeps, seconds, pass, lastTurnEnded } = yield* setup()
      yield* Ref.set(lastTurnEnded, Option.some(yield* Clock.currentTimeMillis))
      yield* runCommand(1)
      yield* seconds(10)
      assert.deepStrictEqual(yield* sleeps, [])
      // The API keeps the sandbox up 90 s after a turn; dreamd asks once 100 s have passed, at its next look.
      yield* pass(1)
      assert.deepStrictEqual(yield* sleeps, [])
      yield* pass(1)
      assert.deepStrictEqual(yield* sleeps, ["command"])
    }).pipe(Effect.scoped)
  )

  it.effect("asks to sleep about a minute and a half after a visit's last request", () =>
    Effect.gen(function* () {
      const { sleeps, asked, pass, port, traffic } = yield* setup()
      yield* Ref.set(port, Option.some(3000))
      yield* pass(0.5)
      // A request, which the kernel keeps in TIME_WAIT for a minute.
      yield* Ref.set(traffic, { open: new Set<string>(), recentlyClosed: 1 })
      yield* pass(1)
      yield* Ref.set(traffic, quiet)
      assert.isAtLeast((yield* asked).length, 1)
      assert.deepStrictEqual(yield* sleeps, [])
      yield* pass(0.5)
      assert.deepStrictEqual(yield* sleeps, ["app"])
      // Once per visit.
      yield* pass(5)
      assert.deepStrictEqual(yield* sleeps, ["app"])
    }).pipe(Effect.scoped)
  )

  it.effect("doesn't ask while someone keeps using the app, and asks once they stop", () =>
    Effect.gen(function* () {
      const { runCommand, sleeps, seconds, pass, port, traffic } = yield* setup()
      yield* Ref.set(port, Option.some(3000))
      yield* Ref.set(traffic, { open: new Set<string>(), recentlyClosed: 1 })
      yield* pass(0.5)
      // A command finishes mid-visit: no ask while the app is in use.
      yield* runCommand(1)
      yield* seconds(10)
      yield* pass(3)
      assert.deepStrictEqual(yield* sleeps, [])
      yield* Ref.set(traffic, quiet)
      yield* pass(1)
      // One ask, naming the command (it outranks the visit).
      assert.deepStrictEqual(yield* sleeps, ["command"])
    }).pipe(Effect.scoped)
  )

  it.effect("leaves out the traffic of dreamd's own look at the published URL", () =>
    Effect.gen(function* () {
      const { sleeps, asked, pass, port, traffic, self } = yield* setup()
      yield* Ref.set(port, Option.some(3000))
      yield* pass(0.5)
      // The look is running: its connection is open.
      yield* Ref.set(self, { running: true, endedMs: undefined })
      yield* Ref.set(traffic, { open: new Set(["check"]), recentlyClosed: 0 })
      yield* pass(0.5)
      // It ended, and its connection sits in TIME_WAIT for a minute.
      yield* Ref.set(self, { running: false, endedMs: yield* Clock.currentTimeMillis })
      yield* Ref.set(traffic, { open: new Set<string>(), recentlyClosed: 1 })
      yield* pass(1)
      yield* Ref.set(traffic, quiet)
      yield* pass(2)
      assert.deepStrictEqual(yield* asked, [])
      assert.deepStrictEqual(yield* sleeps, [])
      // Afterwards a request is someone's visit again.
      yield* Ref.set(traffic, { open: new Set<string>(), recentlyClosed: 1 })
      yield* pass(0.5)
      assert.deepStrictEqual(yield* asked, ["app"])
    }).pipe(Effect.scoped)
  )

  it.effect("asks to stay awake right after a turn ends, when there's work, without waiting a minute", () =>
    Effect.gen(function* () {
      const { busy, asked, pass, seconds, lastTurnEnded } = yield* setup()
      yield* Ref.set(busy, true)
      yield* pass(0.5)
      assert.lengthOf(yield* asked, 1)
      // During the turn the API ignored that ask; once the turn ends, the next look asks again.
      yield* seconds(5)
      yield* Ref.set(lastTurnEnded, Option.some(yield* Clock.currentTimeMillis))
      yield* seconds(25)
      assert.lengthOf(yield* asked, 2)
    }).pipe(Effect.scoped)
  )

  it.effect("asks to stay awake while the app takes a relay delivery", () =>
    Effect.gen(function* () {
      const { delivering, asked, pass } = yield* setup()
      yield* Ref.set(delivering, true)
      yield* pass(2)
      assert.isAtLeast((yield* asked).length, 2)
      assert.isTrue((yield* asked).every((reason) => reason === "relay"))
    }).pipe(Effect.scoped)
  )

  it.effect("doesn't wait for Sleep's answer, which a paused sandbox never gets", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const awake = yield* Ref.make(0)
      const hanging = Layer.succeed(Api, {
        ...Context.get(yield* Layer.build(Api.layerTest(yield* Ref.make<ReadonlyArray<Report>>([]))), Api),
        stayAwake: () => Ref.update(awake, (n) => n + 1),
        sleep: () => Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(Effect.never))
      })
      const { runCommand, seconds, busy } = yield* setup({ api: hanging })
      yield* runCommand(1)
      yield* seconds(10)
      assert.strictEqual(yield* Ref.get(calls), 1)
      // The next wake's work is looked at right away, not after the first ask gives up.
      const before = yield* Ref.get(awake)
      yield* Ref.set(busy, true)
      yield* seconds(61)
      assert.isAbove(yield* Ref.get(awake), before)
      yield* Ref.set(busy, false)
      yield* runCommand(1)
      yield* seconds(10)
      assert.strictEqual(yield* Ref.get(calls), 2)
    }).pipe(Effect.scoped)
  )

  it.effect("carries on when the API doesn't know Sleep", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const refusing = Layer.succeed(Api, {
        ...Context.get(yield* Layer.build(Api.layerTest(yield* Ref.make<ReadonlyArray<Report>>([]))), Api),
        sleep: () =>
          Ref.update(calls, (n) => n + 1).pipe(
            Effect.andThen(Effect.fail(new ApiError({ message: "Unknown request tag: Sleep" })))
          )
      })
      const { runCommand, seconds, fiber } = yield* setup({ api: refusing })
      yield* runCommand(1)
      yield* seconds(10)
      yield* runCommand(1)
      yield* seconds(10)
      assert.strictEqual(yield* Ref.get(calls), 2)
      assert.isUndefined(fiber.pollUnsafe())
    }).pipe(Effect.scoped)
  )
})
