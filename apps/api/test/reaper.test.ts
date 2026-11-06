import { assert, describe, it } from "@effect/vitest"
import { devSandboxMetadata } from "@dream/domain"
import { Context, DateTime, Effect, Layer } from "effect"
import { E2B } from "../src/e2b/E2B.ts"
import { maintenance } from "../src/WorkerLayer.ts"
import { makeCloud } from "./support/Cloud.ts"

describe("the sandbox reaper", () => {
  it.live("kills throwaway sandboxes over an hour old with the maintenance cron, and nothing a user owns", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const e2b = Context.get(cloud.workerContext, E2B)
      const make = (metadata: Record<string, string>, minutesAgo: number) =>
        Effect.gen(function* () {
          const access = yield* e2b.create({
            template: "dream-sandbox",
            timeoutSeconds: 300,
            autoPause: true,
            envVars: {},
            metadata,
            rules: {}
          })
          const sandbox = cloud.world.sandboxes.get(access.sandboxId)!
          sandbox.startedAt = DateTime.subtract(yield* DateTime.now, { minutes: minutesAgo })
          return sandbox
        })
      const forgotten = yield* make(devSandboxMetadata("refresh-check"), 70)
      const unlabeled = yield* make({}, 120)
      const donor = yield* make({ projectId: "prj_1", userId: "usr_1", purpose: "refresh-donor" }, 65)
      const recent = yield* make(devSandboxMetadata("smoke"), 10)
      const project = yield* make({ projectId: "prj_1", userId: "usr_1" }, 600)
      const signIn = yield* make({ purpose: "model-connect", userId: "usr_1", connectionId: "con_1" }, 600)
      const watched = yield* make({ ...devSandboxMetadata("soak"), reaper: "skip" }, 600)
      project.state = "paused"

      yield* maintenance.pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
      assert.deepStrictEqual(
        [forgotten, unlabeled, donor, recent, project, signIn, watched].map((s) => s.state),
        ["killed", "killed", "killed", "running", "paused", "running", "running"]
      )
      yield* cloud.close
    })
  )
})
