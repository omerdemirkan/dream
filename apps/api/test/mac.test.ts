/**
 * A project's Mac over hours of test time: what counts as use, when it stops and why, what the ledger records, and
 * what its activity log keeps. The ProjectDO's services run on their own SQLite and the shared D1, against the
 * fake Namespace (`support/Fakes.ts`).
 */
import { assert, describe, it } from "@effect/vitest"
import { AgentEvent } from "@dream/domain"
import * as fixtures from "@dream/domain/fixtures"
import { Context, DateTime, Duration, Effect, Exit, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ApiConfig } from "../src/Config.ts"
import { MacActivityLog, summarizeMacs } from "../src/db/MacActivity.ts"
import { newEventId } from "../src/lib/Ids.ts"
import { platformLayer } from "../src/Platform.ts"
import { NativeAlarm } from "../src/project/Alarm.ts"
import { Core } from "../src/project/Core.ts"
import { projectLayer } from "../src/project/Layer.ts"
import { Machines } from "../src/project/Machines.ts"
import { emptySandbox } from "../src/project/Store.ts"
import { FakeWorld, fakeServices } from "./support/Fakes.ts"
import { makeD1, makeDoStorage } from "./support/Sqlite.ts"

const quiet = "self 99\nload { 0.40 0.30 0.20 }\ncpu 3.0\nsims 0\n"
const building = [
  "self 99",
  "p 31000 1 me 0.3 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild",
  "p 31001 31000 me 90.0 /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend",
  "cpu 95.0",
  "sims 0",
  ""
].join("\n")

const harness = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-11-08T10:00:00Z"))
  const world = new FakeWorld()
  world.macProbe = quiet
  const { d1, db } = makeD1()
  const storage = makeDoStorage()
  const scope = yield* Scope.make()
  const platform = platformLayer(
    { d1, fetchProject: () => Effect.die("no projects"), fetchRelay: () => Effect.die("no relays") },
    { services: fakeServices(world), config: ApiConfig.layerTest({}) }
  )
  const context = yield* Layer.buildWithScope(
    projectLayer(storage.storage, NativeAlarm.layerTest(storage.alarms)).pipe(Layer.provideMerge(platform)),
    scope
  )
  const core = Context.get(context, Core)
  const machines = Context.get(context, Machines)
  const log = Context.get(context, MacActivityLog)
  yield* core.saveProject(fixtures.liftLog)
  const working = (on: boolean) =>
    Effect.flatMap(core.sandbox, (record) => core.saveSandbox({ ...emptySandbox, ...record, working: on }))
  yield* working(true)
  /** Moves the clock in five-minute checks, as the alarm would run them. */
  const checkFor = (duration: Duration.Input) =>
    Effect.gen(function* () {
      const steps = Math.round(Duration.toMinutes(Duration.fromInputUnsafe(duration)) / 5)
      for (let i = 0; i < steps; i++) {
        yield* TestClock.adjust("5 minutes")
        yield* machines.macCheck
      }
    })
  const metered = () =>
    db
      .prepare("SELECT id, at, quantities_json, dimensions_json, units FROM meter_events WHERE meter = 'mac_session'")
      .all()
      .map((row) => ({
        id: String(row.id),
        at: String(row.at),
        units: Number(row.units),
        quantities: JSON.parse(String(row.quantities_json)) as Record<string, number>,
        dimensions: JSON.parse(String(row.dimensions_json)) as Record<string, string>
      }))
  const activity = (instanceId: string) => log.read({ instanceId })
  const close = Scope.close(scope, Exit.void)
  return { world, machines, core, working, checkFor, metered, activity, close }
})

describe("the Mac", () => {
  it.effect("idles out after 15 minutes with nothing running, however often the agent asks about it", () =>
    Effect.gen(function* () {
      const t = yield* harness
      yield* t.machines.startMac
      for (let minute = 1; minute <= 15; minute++) {
        assert.strictEqual((yield* t.machines.mac).state, "running")
        yield* TestClock.adjust("1 minute")
        if (minute % 5 === 0) yield* t.machines.macCheck
      }
      assert.strictEqual((yield* t.machines.mac).state, "stopped")
      const [event] = t.metered()
      assert.strictEqual(event?.dimensions.stop_reason, "idle")
      assert.strictEqual(event?.dimensions.ended_by, "namespace")
      assert.strictEqual(event?.quantities.ms, 15 * 60_000)
      assert.strictEqual(event?.quantities.idle_ms, 15 * 60_000)
      const instanceId = event!.dimensions.instance!
      const kinds = (yield* t.activity(instanceId)).map((e) => e.activity._tag)
      assert.deepStrictEqual(kinds, [
        "Start",
        ...Array.from({ length: 3 }, () => [...Array.from({ length: 5 }, () => "Status"), "Probe"]).flat(),
        "Stop"
      ])
      yield* t.close
    })
  )

  it.effect("stays up while a build runs on it with no ssh session, keeps its deadline ahead, then idles out", () =>
    Effect.gen(function* () {
      const t = yield* harness
      yield* t.machines.startMac
      yield* t.machines.macSsh
      t.world.macProbe = building
      yield* t.checkFor("2 hours")
      const running = yield* t.machines.mac
      assert.strictEqual(running.state, "running")
      // Asked for 90 minutes at the start; the busy checks kept it at least 30 minutes ahead.
      assert.isTrue(DateTime.toEpochMillis(running.deadline!) >= Date.parse("2026-11-08T12:30:00Z"))
      t.world.macProbe = quiet
      yield* t.checkFor("15 minutes")
      assert.strictEqual((yield* t.machines.mac).state, "stopped")
      const [event] = t.metered()
      assert.strictEqual(event?.dimensions.stop_reason, "idle")
      assert.strictEqual(event?.quantities.ms, 135 * 60_000)
      assert.strictEqual(event?.quantities.ssh_sessions, 1)
      const [summary] = summarizeMacs(yield* t.activity(event!.dimensions.instance!))
      assert.strictEqual(summary?.busyProbes, 24)
      assert.strictEqual(summary?.probes, 27)
      assert.strictEqual(summary?.idleTailMinutes, 15)
      assert.deepStrictEqual(summary?.tools, ["swift-frontend", "xcodebuild"])
      yield* t.close
    })
  )

  it.effect("stops soon after the turn ends with nothing running and nothing waiting", () =>
    Effect.gen(function* () {
      const t = yield* harness
      yield* t.machines.startMac
      yield* t.machines.macSsh
      yield* t.working(false)
      // Something queued for the agent: a turn is coming, so it keeps the Mac.
      yield* t.core.enqueue(
        AgentEvent.cases.UserMessage.make({
          id: yield* newEventId(),
          at: yield* DateTime.now,
          messageId: fixtures.liftLogUpdate.id,
          text: "and the charts?"
        })
      )
      yield* t.checkFor("5 minutes")
      assert.strictEqual((yield* t.machines.mac).state, "running")
      yield* t.close

      const u = yield* harness
      yield* u.machines.startMac
      yield* u.machines.macSsh
      yield* u.working(false)
      yield* u.checkFor("5 minutes")
      assert.strictEqual((yield* u.machines.mac).state, "stopped")
      const [event] = u.metered()
      assert.strictEqual(event?.dimensions.stop_reason, "turn-ended")
      assert.strictEqual(event?.quantities.ms, 5 * 60_000)
      yield* u.close
    })
  )

  it.effect("keeps a busy Mac after the turn ends", () =>
    Effect.gen(function* () {
      const t = yield* harness
      yield* t.machines.startMac
      yield* t.working(false)
      t.world.macProbe = building
      yield* t.checkFor("30 minutes")
      assert.strictEqual((yield* t.machines.mac).state, "running")
      t.world.macProbe = quiet
      yield* t.checkFor("5 minutes")
      assert.strictEqual((yield* t.machines.mac).state, "stopped")
      assert.strictEqual(t.metered()[0]?.dimensions.stop_reason, "turn-ended")
      yield* t.close
    })
  )

  it.effect("meters a Mac Namespace ended at its lifetime cap to Namespace's end, and says so to the agent", () =>
    Effect.gen(function* () {
      const t = yield* harness
      const started = yield* t.machines.startMac
      // Steady ssh use for five hours: Namespace's policy ends it four hours after creation.
      for (let minute = 0; minute < 250; minute += 10) {
        yield* TestClock.adjust("10 minutes")
        const ssh = yield* Effect.exit(t.machines.macSsh)
        if (Exit.isFailure(ssh)) break
      }
      assert.strictEqual((yield* t.machines.mac).state, "stopped")
      const refused = yield* Effect.flip(t.machines.macSsh)
      assert.strictEqual(refused._tag, "InvalidRequest")
      const [event] = t.metered()
      assert.strictEqual(event?.dimensions.stop_reason, "deadline")
      assert.strictEqual(event?.dimensions.ended_by, "namespace")
      // Four hours and the two seconds Namespace takes to destroy it: not the 10 minutes more until Dream noticed.
      assert.strictEqual(event?.quantities.ms, 4 * 3600_000 + 2000)
      assert.strictEqual(event?.units, 240)
      assert.isDefined(started.deadline)
      yield* t.close
    })
  )

  it.effect("meters a stop to when Namespace had already ended the Mac, and says it was the deadline", () =>
    Effect.gen(function* () {
      const t = yield* harness
      yield* t.machines.startMac
      // Namespace's policy moved the deadline in without Dream hearing (as Anki Voice's Mac did, 2026-11-08).
      const [instanceId] = [...t.world.macs.keys()]
      t.world.macs.get(instanceId!)!.deadline = DateTime.add(yield* DateTime.now, { minutes: 40 })
      yield* TestClock.adjust("51 minutes")
      yield* t.machines.stopMac("explicit")
      const [event] = t.metered()
      assert.strictEqual(event?.dimensions.stop_reason, "deadline")
      assert.strictEqual(event?.quantities.ms, 40 * 60_000 + 2000)
      yield* t.close
    })
  )

  it.effect("notices a Mac Namespace destroyed early, and an explicit stop meters to Namespace's times", () =>
    Effect.gen(function* () {
      const t = yield* harness
      yield* t.machines.startMac
      yield* TestClock.adjust("7 minutes")
      const [instanceId] = [...t.world.macs.keys()]
      t.world.macs.get(instanceId!)!.status = "DESTROYED"
      t.world.macs.get(instanceId!)!.destroyedAt = yield* DateTime.now
      yield* TestClock.adjust("3 minutes")
      yield* t.machines.macCheck
      assert.strictEqual((yield* t.machines.mac).state, "stopped")
      const gone = t.metered()[0]
      assert.strictEqual(gone?.dimensions.stop_reason, "provider-gone")
      assert.strictEqual(gone?.quantities.ms, 7 * 60_000)

      yield* t.machines.startMac
      yield* TestClock.adjust("12 minutes")
      yield* t.machines.stopMac("explicit")
      const explicit = t.metered()[1]
      assert.strictEqual(explicit?.dimensions.stop_reason, "explicit")
      assert.strictEqual(explicit?.quantities.ms, 12 * 60_000)
      assert.strictEqual(explicit?.quantities.idle_ms, 12 * 60_000)
      yield* t.close
    })
  )
})
