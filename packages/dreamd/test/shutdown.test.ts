/**
 * Restarts: dreamd's env file changes while a turn runs whose harness never
 * stops. `main` must still return promptly, and the next dreamd must run the
 * interrupted turn's events again. Also, `stopAll` takes down a process's
 * whole group, as it does for a harness bridge and the CLI it started.
 */
import { AppTraffic } from "../src/Awake.ts"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Deferred, Duration, Effect, Fiber, Layer, Queue, Ref, Schedule } from "effect"
import { DreamdConfig } from "../src/Config.ts"
import { layerWith, main } from "../src/Daemon.ts"
import { Harness, type HarnessError, type TurnResult, TurnOutcome } from "../src/harness/Harness.ts"
import { makeSpawned, stopAll } from "../src/harness/LocalSandbox.ts"
import { RelayForwarder } from "../src/Relays.ts"
import { Shutdown } from "../src/Shutdown.ts"
import { configRecord, daemonClient, fakeApi, freePort, noPageChecks, tempDir, userMessage } from "./support.ts"

type Script = (prompt: string) => Effect.Effect<TurnResult, HarnessError>

/** One dreamd process: `main` with a scripted harness, reading its config "from" `envFile`. */
const dreamd = (dir: string, envFile: string, apiPort: number, turns: Queue.Queue<Script>) =>
  Effect.gen(function* () {
    const daemonPort = yield* Effect.promise(freePort)
    const log = yield* Ref.make<ReadonlyArray<string>>([])
    const env = configRecord(dir, {
      DREAM_API_URL: `http://127.0.0.1:${apiPort}`,
      DREAM_DAEMON_PORT: String(daemonPort)
    })
    const fiber = yield* main.pipe(
      Effect.provide(
        layerWith(
          Layer.mergeAll(
            Harness.layerTest({ turns, log }),
            Shutdown.layerTest({ grace: "300 millis" }),
            noPageChecks,
            AppTraffic.layerNone,
            RelayForwarder.layerNone
          )
        ).pipe(Layer.provideMerge(DreamdConfig.layerFromRecord(env, envFile)), Layer.provideMerge(NodeServices.layer))
      ),
      Effect.forkScoped
    )
    return { daemonPort, log, fiber }
  })

describe("restarting", () => {
  it.live("interrupts a turn whose harness won't stop, exits in bounded time, and reruns the turn", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const envFile = join(dir, "dreamd.env")
      writeFileSync(envFile, "DREAM_MODEL=old\n")
      const apiPort = yield* Effect.promise(freePort)
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      yield* Layer.build(fakeApi(calls, apiPort))

      const turns = yield* Queue.unbounded<Script>()
      const started = yield* Deferred.make<void>()
      // The turn runs until interrupted, and then never finishes stopping.
      yield* Queue.offer(turns, () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.never)
        )
      )
      const first = yield* dreamd(dir, envFile, apiPort, turns)
      const client = yield* daemonClient(first.daemonPort, "daemon-token")
      // dreamd is still starting; the DO retries the same way.
      yield* client
        .Deliver({ events: [userMessage(1, "Make the charts blue")] })
        .pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }))
      yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))

      const changedAt = Date.now()
      writeFileSync(envFile, "DREAM_MODEL=new\n")
      yield* Fiber.join(first.fiber).pipe(Effect.timeout("5 seconds"))
      const took = Date.now() - changedAt
      // The watch notices at once (no 5 s poll), then the 300 ms grace runs out.
      assert.isBelow(took, 3_000)

      // The supervisor starts dreamd again; the interrupted turn's event starts its first turn.
      yield* Queue.offer(turns, () => Effect.succeed({ outcome: TurnOutcome.Completed(), usage: {}, progressed: true }))
      const second = yield* dreamd(dir, envFile, apiPort, turns)
      while (!(yield* Ref.get(second.log)).some((line) => line.includes("Make the charts blue"))) {
        yield* Effect.sleep("20 millis")
      }
      const health = yield* (yield* daemonClient(second.daemonPort, "daemon-token"))
        .Health()
        .pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }))
      assert.strictEqual(health.queued, 0)
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"))
  )
})

describe("stopAll", () => {
  it.live("stops a child's whole process group", () =>
    Effect.gen(function* () {
      const spawned = makeSpawned()
      // Like a bridge that started a CLI: the grandchild outlives a signal to the child alone.
      const child = spawn("sleep 30 & echo $!; wait", { shell: "/bin/bash", detached: true, stdio: "pipe" })
      spawned.add(child)
      const grandchild = yield* Effect.promise(
        () => new Promise<number>((resolve) => child.stdout.once("data", (data: Buffer) => resolve(Number(data))))
      )
      const startedAt = Date.now()
      yield* Effect.promise(() => stopAll(spawned))
      assert.isBelow(Date.now() - startedAt, Duration.toMillis(Duration.seconds(3)))
      yield* Effect.sleep("50 millis")
      assert.throws(() => process.kill(grandchild, 0))
    })
  )
})
