/**
 * Checks usage limits end to end with a real dreamd on real E2B, against the fake model server that ships in the
 * template, so no account, project or subscription is touched:
 *
 *   ol expose 8793                                   (the sandbox's dreamd reaches the stand-in API through it)
 *   NODE_USE_ENV_PROXY=1 node apps/api/scripts/usage-limits-check.ts <exposed URL> [port] [template]
 *                                                    (default 8793, dream-sandbox)
 *
 * The control plane runs here, as in the tests (`test/support/Cloud.ts`): the Worker's handlers and a ProjectDO on
 * node:sqlite, with APNs, Google and the model connection faked. Only dreamd is real: E2B is faked for the
 * ProjectDO, which writes dreamd's env file into its fake sandbox, and every call it makes to dreamd goes to a real
 * sandbox of the template with that env file copied in, where dreamd calls back here and Claude Code talks to
 * fake-anthropic. Plan readings are injected as dreamd would report them (`ReportUsage`), since the fake model sends
 * no rate limits.
 *
 * It sets a limit on the project's share, crosses it during a turn and checks the turn finishes, the project pauses
 * (Home's row, the push, dreamd told to hold), nothing new reaches the model (a message waits, and an event handed
 * to dreamd directly starts no turn), and that raising the limit resumes it and delivers what waited. Then a floor
 * on what's left of the plan pauses it at once, and clearing it resumes it. The sandbox is a dev sandbox, killed at
 * the end. Needs E2B_API_KEY, or an HTTPS proxy that adds it.
 */
import { createServer } from "node:http"
import {
  AgentEvent,
  DaemonEnvFile,
  devSandboxMetadata,
  type EventId,
  type MessageId,
  UpstreamFailure
} from "@dream/domain"
import { type Context, DateTime, Effect, Layer, ManagedRuntime, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { ApiConfig } from "../src/Config.ts"
import { Daemon } from "../src/e2b/Daemon.ts"
import { E2B, type SandboxAccess } from "../src/e2b/E2B.ts"
import { Envd } from "../src/e2b/Envd.ts"
import { makeCloud } from "../test/support/Cloud.ts"
import { type FakeWorld, fakeServices } from "../test/support/Fakes.ts"

const [publicUrl, portArg = "8793", template = "dream-sandbox"] = process.argv.slice(2)
if (publicUrl === undefined) {
  console.error("Usage: node apps/api/scripts/usage-limits-check.ts <exposed URL> [port] [template]")
  process.exit(2)
}
const apiUrl = publicUrl.replace(/\/+$/, "")
const port = Number(portArg)
const scripts = "/opt/dream/packages/dreamd/scripts"
const log = "/home/user/.dream/logs/dreamd.log"
const stamp = () => new Date().toISOString().slice(11, 19)
const say = (line: string) => console.log(`${stamp()} ${line}`)

const results: Array<{ check: string; ok: boolean }> = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok })
  say(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`)
}

// The real providers, for the one real sandbox.
const real = ManagedRuntime.make(
  Layer.mergeAll(E2B.layer, Envd.layer, Daemon.layer).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      ApiConfig.layerTest({
        e2bApiKey: Option.some(Redacted.make(process.env.E2B_API_KEY ?? "placeholder-added-by-proxy")),
        e2bApiUrl: "https://api.e2b.app",
        e2bDomain: "e2b.app",
        sandboxTemplate: template
      })
    )
  )
)
const run = <A, E>(effect: Effect.Effect<A, E, E2B | Envd | Daemon>) => real.runPromise(effect)
const sh = (sandbox: SandboxAccess, command: string) =>
  run(Envd.use((envd) => envd.run(sandbox, { command, timeout: "2 minutes" }))).then((r) => r.output.trim())

const sandbox = await run(
  E2B.use((e2b) =>
    e2b.create({
      template,
      timeoutSeconds: 30 * 60,
      autoPause: false,
      envVars: {},
      metadata: devSandboxMetadata("usage-limits-check"),
      rules: {}
    })
  )
)
say(`sandbox ${sandbox.sandboxId} (${template})`)
const kill = () => run(E2B.use((e2b) => e2b.kill(sandbox.sandboxId))).catch(() => {})

/** The fake sandbox's env file, as the ProjectDO last wrote it, copied into the real one when it changes. */
let written: string | undefined
const syncEnv = (world: FakeWorld) =>
  Effect.gen(function* () {
    const fake = [...world.sandboxes.values()][0]
    const env = fake?.files.get(DaemonEnvFile)
    if (env === undefined || env === written) return
    written = env
    yield* Effect.promise(() => run(Envd.use((envd) => envd.writeFile(sandbox, DaemonEnvFile, env))))
    say("wrote dreamd's env file into the sandbox")
  })
const toUpstream = (error: unknown) => new UpstreamFailure({ service: "dreamd", message: String(error) })
const viaReal = <A>(
  world: FakeWorld,
  use: (daemon: Context.Service.Shape<typeof Daemon>) => Effect.Effect<A, unknown>
) => Effect.andThen(syncEnv(world), Effect.tryPromise({ try: () => run(Daemon.use(use)), catch: toUpstream }))
const holds: Array<boolean> = []
const bridge = (world: FakeWorld) =>
  Layer.succeed(
    Daemon,
    Daemon.of({
      deliver: (_s, token, events, timeZone) => viaReal(world, (d) => d.deliver(sandbox, token, events, timeZone)),
      forwardRelay: (_s, token, request) => viaReal(world, (d) => d.forwardRelay(sandbox, token, request)),
      setWatching: (_s, token, watching) => viaReal(world, (d) => d.setWatching(sandbox, token, watching)),
      holdTurns: (_s, token, held) => {
        holds.push(held)
        say(`ProjectDO → dreamd: HoldTurns(${held})`)
        return viaReal(world, (d) => d.holdTurns(sandbox, token, held))
      },
      health: (_s, token) => viaReal(world, (d) => d.health(sandbox, token))
    })
  )

const program = async () => {
  await sh(sandbox, "mkdir -p /tmp/fakes /home/user/.claude")
  await run(
    Envd.use((envd) =>
      envd.writeFile(
        sandbox,
        "/home/user/.claude/settings.json",
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18789" } })
      )
    )
  )
  await run(
    Envd.use((envd) =>
      envd.startBackground(sandbox, {
        command: `node ${scripts}/fake-anthropic.ts 18789 > /tmp/fakes/anthropic.log 2>&1`
      })
    )
  )
  const modelRequests = async () => Number(await sh(sandbox, "grep -c . /tmp/fakes/anthropic.log || true"))
  const dreamdLog = (text: string) => sh(sandbox, `grep -c ${JSON.stringify(text)} ${log} || true`).then(Number)

  const cloud = await Effect.runPromise(
    makeCloud(
      { apiUrl, apiHost: new URL(apiUrl).host, sandboxRefresh: false, sandboxTemplate: template },
      { services: (world) => Layer.merge(fakeServices(world), bridge(world)) }
    )
  )
  const server = createServer(async (req, res) => {
    const chunks: Array<Uint8Array> = []
    for await (const chunk of req) chunks.push(chunk)
    const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    chunks.reduce((offset, c) => (body.set(c, offset), offset + c.length), 0)
    const request = new Request(`${apiUrl}${req.url}`, {
      method: req.method ?? "GET",
      headers: Object.entries(req.headers).flatMap(([k, v]) =>
        typeof v === "string" ? [[k, v] as [string, string]] : []
      ),
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { body })
    })
    const response =
      new URL(request.url).pathname === "/sandbox/rpc"
        ? await cloud.sandboxHandler(request)
        : new Response("not here", { status: 404 })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(new Uint8Array(await response.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve))
  say(`stand-in API on :${port}, reachable at ${apiUrl}`)

  const phone = cloud.phone
  const signedIn = await Effect.runPromise(
    phone.DevSignIn({ email: "check@example.com", secret: Redacted.make("dev-secret") })
  )
  cloud.session.token = Redacted.value(signedIn.sessionToken)
  await Effect.runPromise(
    phone.RegisterDevice({
      deviceId: "8f14e45f-ceea-4e7b-9a0c-6a3f1b2c3d4e" as never,
      apnsToken: "check-device-token",
      timeZone: "America/Los_Angeles"
    })
  )
  const claudeUrl =
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
  cloud.world.scripts.set("claude setup-token", [
    { _tag: "Output", text: `Use the url below\r\n${claudeUrl}\r\n` },
    { _tag: "Output", text: "Paste code here if prompted > " }
  ])
  const started = await Effect.runPromise(phone.StartModelConnection({ provider: "claude" }))
  cloud.world.attachOutput = [
    { _tag: "Output", text: "Long-lived authentication token created successfully!\r\n" },
    { _tag: "Output", text: `sk-ant-oat01-${"x".repeat(60)}\r\n` }
  ]
  await Effect.runPromise(
    phone.CompleteModelConnection({ connectionId: started.connection.id, code: Redacted.make("code#state") })
  )
  const project = await Effect.runPromise(phone.CreateProject({ idea: "Say hello." }))

  // workerd fires the ProjectDO's alarm; here a ticker does, once a second.
  let ticking = false
  const ticker = setInterval(() => {
    if (ticking) return
    ticking = true
    Effect.runPromise(cloud.alarm(project.id))
      .catch((error) => say(`alarm failed: ${String(error)}`))
      .finally(() => {
        ticking = false
      })
  }, 1000)

  const turns = () => (cloud.db.prepare("SELECT COUNT(*) AS n FROM turn_usage").all() as Array<{ n: number }>)[0]!.n
  const summary = async () => (await Effect.runPromise(phone.ListProjects()))[0]
  const until = async (what: string, test: () => Promise<boolean> | boolean, seconds = 180) => {
    for (let i = 0; i < seconds; i++) {
      if (await test()) return true
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    say(`gave up waiting: ${what}`)
    return false
  }
  const fake = () => [...cloud.world.sandboxes.values()][0]!
  const envValue = (name: string) =>
    JSON.parse(
      fake()
        .files.get(DaemonEnvFile)!
        .split("\n")
        .find((line) => line.startsWith(`${name}=`))!
        .slice(name.length + 1)
    ) as string
  const weekResets = new Date(Date.now() + 3 * 24 * 3600_000)
  const reading = async (week: number) => {
    const dreamd = await Effect.runPromise(cloud.sandbox(envValue("DREAM_PROJECT_TOKEN")))
    await Effect.runPromise(
      dreamd.ReportUsage({
        usage: {
          provider: "claude",
          weekly: { usedPercent: week, resetsAt: DateTime.makeUnsafe(weekResets) },
          observedAt: DateTime.nowUnsafe()
        }
      })
    )
  }

  check("the first turn ran on the real dreamd", await until("the first turn", () => turns() >= 1))
  await reading(20)

  // A turn under way when the limit is crossed finishes; nothing starts after it.
  await Effect.runPromise(phone.SendMessage({ projectId: project.id, text: "RUN: sleep 25" }))
  check(
    "a second turn started",
    await until("the second turn to start", async () => (await summary())?.activity?.state === "working")
  )
  await reading(35)
  const set = await Effect.runPromise(
    phone.SetUsageLimits({ projectId: project.id, limits: { projectWeekPercent: 10 } })
  )
  check("a 10% limit is set, not yet reached mid-turn", set.limitReached === undefined, JSON.stringify(set.weekWindow))
  check("the turn under way finished", await until("the second turn to finish", () => turns() >= 2))
  const paused = await summary()
  check(
    "the project is paused by its limit",
    paused?.pausedBy?.limit === "project" && paused.pausedBy.percent === 10,
    JSON.stringify({ pausedUntil: paused?.pausedUntil, pausedBy: paused?.pausedBy })
  )
  const alert = cloud.world.pushes.findLast((p) => p.kind === "alert")?.payload as
    | { body?: string; data?: { _tag?: string } }
    | undefined
  check("the push went out", alert?.data?._tag === "OpenUsage", alert?.body ?? "none")
  check("dreamd was told to hold", holds.includes(true) && (await dreamdLog("A usage limit holds the project")) > 0)

  const requests = await modelRequests()
  await Effect.runPromise(phone.SendMessage({ projectId: project.id, text: "Are you still there?" }))
  await new Promise((resolve) => setTimeout(resolve, 15_000))
  const health = await run(Daemon.use((d) => d.health(sandbox, envValue("DREAM_DAEMON_TOKEN"))))
  check(
    "a message waits, and nothing reaches the model",
    (await modelRequests()) === requests && turns() === 2,
    `${requests} → ${await modelRequests()} model requests, dreamd ${health.turn}`
  )
  // An event dreamd already has starts no turn while it's held.
  await run(
    Daemon.use((d) =>
      d.deliver(sandbox, envValue("DREAM_DAEMON_TOKEN"), [
        AgentEvent.cases.UserMessage.make({
          id: "evt_direct_check" as EventId,
          at: DateTime.nowUnsafe(),
          messageId: "msg_direct_check" as MessageId,
          text: "This reached dreamd before the limit."
        })
      ])
    )
  )
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  const heldHealth = await run(Daemon.use((d) => d.health(sandbox, envValue("DREAM_DAEMON_TOKEN"))))
  check(
    "dreamd keeps what it has queued while held",
    heldHealth.turn === "idle" && heldHealth.queued >= 1 && (await modelRequests()) === requests,
    `turn ${heldHealth.turn}, ${heldHealth.queued} queued`
  )

  // Raising the limit resumes it, and what waited is delivered.
  const raised = await Effect.runPromise(
    phone.SetUsageLimits({ projectId: project.id, limits: { projectWeekPercent: 40 } })
  )
  check(
    "raising the limit resumes it",
    raised.limitReached === undefined && (await summary())?.pausedUntil === undefined
  )
  check(
    "what waited ran in a turn",
    await until("the next turn", () => turns() >= 3),
    `${await modelRequests()} model requests`
  )
  check(
    "dreamd was released",
    holds.at(-1) === false && (await dreamdLog("The usage limit no longer holds the project")) > 0
  )
  const withdrawn = cloud.world.pushes.findLast((p) => p.kind === "silent")?.payload as { _tag?: string } | undefined
  check("the paused notification was withdrawn", withdrawn?._tag === "Withdraw")

  // A floor on what's left of the plan pauses at once when the plan is already below it.
  await until("the turn to end", async () => (await summary())?.activity?.state !== "working", 120)
  const floor = await Effect.runPromise(
    phone.SetUsageLimits({ projectId: project.id, limits: { planLeftPercent: 70 } })
  )
  check("a floor above what's left pauses it", floor.limitReached?.limit === "planLeft")
  const cleared = await Effect.runPromise(phone.SetUsageLimits({ projectId: project.id, limits: {} }))
  check("clearing it resumes it", cleared.limitReached === undefined && cleared.limits === undefined)
  const pushes = cloud.world.pushes.filter((p) => p.kind === "alert").map((p) => (p.payload as { body: string }).body)
  say(`pushes:\n  ${pushes.join("\n  ")}`)
  say(`dreamd log:\n${await sh(sandbox, `grep -E "usage limit|Turn (started|finished)" ${log} | tail -20`)}`)

  clearInterval(ticker)
  await Effect.runPromise(cloud.close)
}

try {
  await program()
} catch (error) {
  console.error(error)
  check("ran to the end", false, String(error))
} finally {
  await kill()
  await real.dispose()
}
const failed = results.filter((r) => !r.ok)
say(failed.length === 0 ? `all ${results.length} checks passed` : `${failed.length} of ${results.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
