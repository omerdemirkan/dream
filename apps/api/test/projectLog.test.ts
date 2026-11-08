/** The ProjectDO's half of the project's log, and the alerts it raises when the published app fails people. */
import { assert, describe, it } from "@effect/vitest"
import { type AgentEvent, DaemonEnvFile, type ProjectId } from "@dream/domain"
import { DateTime, Duration, Effect, Redacted } from "effect"
import { gateway } from "../src/http/Gateway.ts"
import { requestEntry, TroubleRules, type TroubleState, watchRequests } from "../src/project/ProjectLog.ts"
import type { GatewayRequest } from "../src/project/ProjectRpcs.ts"
import { makeCloud } from "./support/Cloud.ts"

const base = Date.UTC(2026, 10, 8, 14, 0)
const request = (
  secondsIn: number,
  status: number | "not-listening" | "no-answer",
  path = "/api/items"
): GatewayRequest => ({
  at: DateTime.makeUnsafe(base + secondsIn * 1000),
  method: "GET",
  path,
  ...(typeof status === "number" ? { outcome: "answered" as const, status } : { outcome: status }),
  ms: 120
})
const minutes = (n: number) => base + n * 60_000

describe("the gateway's requests in the log", () => {
  it("are errors for server errors, warnings when slow or never reaching the app", () => {
    assert.strictEqual(requestEntry(request(0, 500)).level, "error")
    assert.strictEqual(requestEntry(request(0, 500)).text, "GET /api/items → 500 in 120 ms")
    assert.strictEqual(requestEntry(request(0, 404)).level, "info")
    assert.strictEqual(requestEntry({ ...request(0, 200), ms: 4200 }).level, "warn")
    assert.include(requestEntry({ ...request(0, 200), ms: 4200 }).text, "in 4.2 s (slow)")
    const unreachable = requestEntry(request(0, "not-listening"))
    assert.strictEqual(unreachable.level, "warn")
    assert.include(unreachable.text, "nothing was listening on the published port")
  })
})

describe("watching the published app", () => {
  it("alerts once three server errors come within the window, and not again while it lasts", () => {
    const first = watchRequests({}, [request(0, 500), request(10, 200)], minutes(1), false)
    assert.lengthOf(first.alerts, 0)
    const second = watchRequests(first.state, [request(70, 502), request(80, 500, "/api/save")], minutes(2), false)
    assert.lengthOf(second.alerts, 1)
    assert.strictEqual(second.alerts[0]?.kind, "server-errors")
    assert.deepStrictEqual(second.alerts[0]?.watch.samples, [
      "GET /api/items → 500 in 120 ms",
      "GET /api/items → 502 in 120 ms",
      "GET /api/save → 500 in 120 ms"
    ])
    const third = watchRequests(
      second.state,
      [request(130, 500), request(140, 500), request(150, 500)],
      minutes(3),
      false
    )
    assert.lengthOf(third.alerts, 0)
  })

  it("doesn't count errors during a turn, when the agent is likely working on the app", () => {
    const during = watchRequests({}, [request(0, 500), request(1, 500), request(2, 500)], minutes(1), true)
    assert.lengthOf(during.alerts, 0)
    assert.deepStrictEqual(during.state, {})
  })

  it("forgets errors older than the window", () => {
    const old = watchRequests({}, [request(0, 500), request(1, 500)], minutes(1), false)
    const later = watchRequests(old.state, [request(60 * 20, 500)], minutes(21), false)
    assert.lengthOf(later.alerts, 0)
    assert.lengthOf(later.state["server-errors"]?.recent ?? [], 1)
  })

  it("alerts again after the cool-down, or sooner once the app has recovered for a while", () => {
    const errors = (from: number) => [request(from, 500), request(from + 1, 500), request(from + 2, 500)]
    const alerted = watchRequests({}, errors(0), minutes(1), false)
    assert.lengthOf(alerted.alerts, 1)
    // Fine for a while, an hour on: the run is over, and new errors are a new problem.
    const fine = Array.from({ length: TroubleRules.recoveredAfter }, (_, i) => request(600 + i, 200))
    const recovered = watchRequests(alerted.state, fine, minutes(30), false)
    const soon = watchRequests(recovered.state, errors(1900), minutes(32), false)
    assert.lengthOf(soon.alerts, 0, "within the recovered cool-down")
    const hourOn = watchRequests(soon.state, errors(3700), minutes(62), false)
    assert.lengthOf(hourOn.alerts, 1)
    // Without recovering, only once the long cool-down has passed.
    const stillFailing: TroubleState = watchRequests({}, errors(0), minutes(1), false).state
    const sixHoursOn = minutes(1) + Duration.toMillis(TroubleRules.coolDown)
    assert.lengthOf(watchRequests(stillFailing, errors(3700), minutes(62), false).alerts, 0)
    assert.lengthOf(watchRequests(stillFailing, errors((sixHoursOn - base) / 1000), sixHoursOn, false).alerts, 1)
  })

  it("alerts about requests never reaching the app only when it lasts a minute", () => {
    const burst = watchRequests(
      {},
      [request(0, "not-listening"), request(1, "not-listening"), request(3, "no-answer")],
      minutes(1),
      false
    )
    assert.lengthOf(burst.alerts, 0, "one visitor's waking page retrying")
    const lasting = watchRequests(burst.state, [request(75, "not-listening")], minutes(2), false)
    assert.lengthOf(lasting.alerts, 1)
    assert.strictEqual(lasting.alerts[0]?.kind, "unreachable")
  })
})

// ---------------------------------------------------------------------------
// End to end: the gateway, the DO, dreamd's ReadLog and the agent's inbox
// ---------------------------------------------------------------------------

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const setup = (cloud: Cloud) =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({ email: "ada@example.com", secret: Redacted.make("dev-secret") })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
    cloud.world.scripts.set("claude setup-token", [
      { _tag: "Output", text: `Use the url below\r\n${claudeUrl}\r\n` },
      { _tag: "Output", text: "Paste code here if prompted > " }
    ])
    const started = yield* cloud.phone.StartModelConnection({ provider: "claude" })
    cloud.world.attachOutput = [
      { _tag: "Output", text: "Long-lived authentication token created successfully!\r\n" },
      { _tag: "Output", text: `sk-ant-oat01-${"x".repeat(60)}\r\n` }
    ]
    yield* cloud.phone.CompleteModelConnection({ connectionId: started.connection.id, code: Redacted.make("c#s") })
    const project = yield* cloud.phone.CreateProject({ idea: "A recipe box." })
    yield* cloud.alarm(project.id)
    const dreamd = yield* cloud.sandbox(tokenOf(cloud, project.id))
    yield* dreamd.Publish({ port: 3000 })
    return { project, dreamd }
  })

const tokenOf = (cloud: Cloud, projectId: ProjectId): string => {
  const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  const line = sandbox.files
    .get(DaemonEnvFile)!
    .split("\n")
    .find((l) => l.startsWith("DREAM_PROJECT_TOKEN="))!
  return JSON.parse(line.slice("DREAM_PROJECT_TOKEN=".length))
}

/** Requests the gateway forwards to a sandbox get `status` from the app. */
const appAnswers = (status: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const real = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        return /^https:\/\/3000-/.test(url) ? new Response("boom", { status }) : real(input, init)
      }) as typeof fetch
      return real
    }),
    (real) => Effect.sync(() => (globalThis.fetch = real))
  )

const alerts = (cloud: Cloud) =>
  cloud.world.delivered
    .flatMap((d) => d.events as ReadonlyArray<AgentEvent>)
    .filter((e): e is Extract<AgentEvent, { _tag: "Alert" }> => e._tag === "Alert")

describe("the published app failing people", () => {
  it.live("is in the log dreamd reads, and wakes the agent once", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const host = new URL(project.publicUrl).host
      yield* appAnswers(500)
      for (const path of ["/", "/api/items", "/api/items?page=2", "/api/save"]) {
        const response = yield* gateway(host, new Request(`${project.publicUrl}${path}`)).pipe(
          Effect.provideContext(cloud.workerContext)
        )
        // The app's own response, passed on as it is.
        assert.strictEqual(response.body._tag === "Raw" ? (response.body.body as Response).status : 0, 500)
      }
      // The gateway hands its requests over a few seconds after the first.
      yield* Effect.sleep("3500 millis")
      const { entries } = yield* dreamd.ReadLog({ sources: ["gateway"] })
      assert.deepStrictEqual(
        entries.map((entry) => [entry.level, entry.text.replace(/ in \d+ ms$/, "")]),
        [
          ["error", "GET / → 500"],
          ["error", "GET /api/items → 500"],
          ["error", "GET /api/items?page=2 → 500"],
          ["error", "GET /api/save → 500"]
        ]
      )
      const told = yield* dreamd.ReadLog({ sources: ["dream"], errors: true })
      assert.include(told.entries.at(-1)?.text, "Told you: Your published app")

      yield* cloud.alarm(project.id)
      const [alert, ...more] = alerts(cloud)
      assert.lengthOf(more, 0)
      assert.strictEqual(alert?.noticed, "server-errors")
      assert.include(alert?.reason, `Your published app (${project.publicUrl}) answered 4 requests with server errors`)
      assert.include(alert?.reason, "- GET /api/save → 500")
      yield* cloud.close
    }).pipe(Effect.scoped)
  )

  it.live("doesn't wake the agent for errors during its turn", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      const host = new URL(project.publicUrl).host
      yield* appAnswers(503)
      for (let i = 0; i < 4; i++) {
        yield* gateway(host, new Request(`${project.publicUrl}/`)).pipe(Effect.provideContext(cloud.workerContext))
      }
      yield* Effect.sleep("3500 millis")
      assert.lengthOf((yield* dreamd.ReadLog({ errors: true })).entries, 4)
      yield* cloud.alarm(project.id)
      assert.lengthOf(alerts(cloud), 0)
      yield* cloud.close
    }).pipe(Effect.scoped)
  )
})
