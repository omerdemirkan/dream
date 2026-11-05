/**
 * Against the real E2B API (through the sandbox's credential proxy): the REST
 * client, envd processes (plain and PTY), files, and the model sign-in flows
 * up to the point where a person would act. Skipped unless DREAM_LIVE_E2B=1.
 *
 *   DREAM_LIVE_E2B=1 DREAM_LIVE_TEMPLATE=dream-probe bunx vitest run --project @dream/api test/live
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, Layer, Option, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { ApiConfig } from "../../src/Config.ts"
import { findClaudeUrl, findDeviceCode } from "../../src/connect/ModelConnect.ts"
import { E2B, type SandboxAccess } from "../../src/e2b/E2B.ts"
import { Envd } from "../../src/e2b/Envd.ts"

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const live = env.DREAM_LIVE_E2B === "1"
const template = env.DREAM_LIVE_TEMPLATE ?? "dream-probe"

const layer = Layer.mergeAll(E2B.layer, Envd.layer).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ApiConfig.layerTest({ e2bApiUrl: "https://api.e2b.app", e2bDomain: "e2b.app" }))
)

const withSandbox = <A, E, R>(use: (sandbox: SandboxAccess) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const e2b = yield* E2B
      return yield* e2b.create({
        template,
        timeoutSeconds: 300,
        autoPause: false,
        envVars: {},
        metadata: { purpose: "control-plane-live-test" },
        rules: { "httpbin.org": [{ transform: { headers: { "X-Dream-Test": "injected" } } }] }
      })
    }),
    use,
    (sandbox) =>
      Effect.gen(function* () {
        const e2b = yield* E2B
        yield* e2b.kill(sandbox.sandboxId).pipe(Effect.ignore)
      })
  )

describe.skipIf(!live)("E2B, live", () => {
  it.live(
    "runs processes, reads and writes files, and injects egress headers",
    () =>
      withSandbox((sandbox) =>
        Effect.gen(function* () {
          const envd = yield* Envd
          const e2b = yield* E2B
          const which = yield* envd.run(sandbox, { command: "node --version; command -v claude codex || true" })
          console.log("template tools:", which.output.trim().replace(/\n/g, " | "))
          yield* envd.writeFile(sandbox, "/home/user/.dream/dreamd.env", 'DREAM_PROJECT_ID="prj_test"\n')
          const file = yield* envd.readFile(sandbox, "/home/user/.dream/dreamd.env")
          assert.deepStrictEqual(file, Option.some('DREAM_PROJECT_ID="prj_test"\n'))
          assert.isTrue(Option.isNone(yield* envd.readFile(sandbox, "/home/user/nope")))
          const echoed = yield* envd.run(sandbox, { command: "curl -s https://httpbin.org/headers" })
          assert.include(echoed.output, "injected")
          assert.isTrue(
            yield* e2b.updateRules(sandbox.sandboxId, {
              "httpbin.org": [{ transform: { headers: { "X-Dream-Test": "v2" } } }]
            })
          )
          const again = yield* envd.run(sandbox, { command: "curl -s https://httpbin.org/headers" })
          assert.include(again.output, "v2")
          // A PTY process keeps running after its stream is dropped, and takes input later.
          const output = yield* envd
            .start(sandbox, { command: "read -r line; echo got:$line", pty: { cols: 200, rows: 20 } })
            .pipe(Stream.take(1), Stream.runCollect)
          const pid = output[0]?._tag === "Start" ? output[0].pid : -1
          const reader = yield* envd.attach(sandbox, pid).pipe(
            Stream.filter((event) => event._tag === "Output"),
            Stream.map((event) => (event._tag === "Output" ? event.text : "")),
            Stream.takeUntil((text) => text.includes("got:")),
            Stream.runCollect,
            Effect.forkChild
          )
          yield* Effect.sleep("500 millis")
          yield* envd.sendInput(sandbox, pid, "hello\r", true)
          const text = (yield* Fiber.join(reader)).join("")
          assert.include(text, "got:hello")
        })
      ).pipe(Effect.provide(layer)),
    120_000
  )

  it.live(
    "shows Codex's device code",
    () =>
      withSandbox((sandbox) =>
        Effect.gen(function* () {
          const envd = yield* Envd
          const text = yield* envd
            .start(sandbox, {
              command:
                "command -v codex >/dev/null 2>&1 || npm install -g @openai/codex >/dev/null 2>&1; mkdir -p ~/.codex && exec codex login --device-auth"
            })
            .pipe(
              Stream.mapAccum(
                () => "",
                (acc, event) => {
                  const next = event._tag === "Output" ? acc + event.text : acc
                  return [next, [next]] as const
                }
              ),
              Stream.takeUntil((acc) => Option.isSome(findDeviceCode(acc))),
              Stream.runLast,
              Effect.timeout("150 seconds")
            )
          const found = Option.flatMap(text, findDeviceCode)
          console.log("device code flow:", Option.getOrUndefined(Option.map(found, (f) => f.url)))
          assert.isTrue(Option.isSome(found))
        })
      ).pipe(Effect.provide(layer)),
    200_000
  )

  it.live(
    "shows Claude's setup-token link in a PTY",
    () =>
      withSandbox((sandbox) =>
        Effect.gen(function* () {
          const envd = yield* Envd
          const text = yield* envd
            .start(sandbox, {
              command:
                "command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1; exec claude setup-token",
              pty: { cols: 500, rows: 40 }
            })
            .pipe(
              Stream.mapAccum(
                () => "",
                (acc, event) => {
                  const next = event._tag === "Output" ? acc + event.text : acc
                  return [next, [next]] as const
                }
              ),
              Stream.takeUntil((acc) => Option.isSome(findClaudeUrl(acc))),
              Stream.runLast,
              Effect.timeout("150 seconds")
            )
          const url = Option.flatMap(text, findClaudeUrl)
          console.log("claude url host:", Option.getOrUndefined(Option.map(url, (u) => new URL(u).host)))
          assert.isTrue(Option.isSome(url))
        })
      ).pipe(Effect.provide(layer)),
    200_000
  )

  it.live(
    "a paused sandbox reads as paused and connect resumes it, restarting the run clock",
    () =>
      Effect.gen(function* () {
        const e2b = yield* E2B
        const sandbox = yield* e2b.create({
          template,
          timeoutSeconds: 300,
          autoPause: true,
          envVars: {},
          metadata: { purpose: "control-plane-live-test" },
          rules: {}
        })
        yield* Effect.gen(function* () {
          const first = Option.getOrThrow(yield* e2b.info(sandbox.sandboxId))
          assert.strictEqual(first.state, "running")
          assert.isDefined(first.startedAt)
          yield* e2b.pause(sandbox.sandboxId)
          assert.strictEqual(Option.getOrThrow(yield* e2b.info(sandbox.sandboxId)).state, "paused")
          // What the old keepalive did: it doesn't resume a paused sandbox.
          const timeout = yield* e2b.setTimeout(sandbox.sandboxId, 600).pipe(Effect.flip)
          assert.strictEqual(timeout._tag, "SandboxGone")
          yield* e2b.connect(sandbox.sandboxId, 600)
          const resumed = Option.getOrThrow(yield* e2b.info(sandbox.sandboxId))
          assert.strictEqual(resumed.state, "running")
          assert.isTrue(DateTime.isGreaterThan(resumed.startedAt!, first.startedAt!))
        }).pipe(Effect.ensuring(e2b.kill(sandbox.sandboxId).pipe(Effect.ignore)))
      }).pipe(Effect.provide(layer)),
    120_000
  )
})
