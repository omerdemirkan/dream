/**
 * Checks two plans end to end with real dreamds on real E2B, one project per harness, against the fake model
 * servers that ship in the template, so no account, project or subscription is touched:
 *
 *   ol expose 8794                                   (the sandboxes' dreamds reach the stand-in API through it)
 *   NODE_USE_ENV_PROXY=1 node apps/api/scripts/two-plans-check.ts <exposed URL> [port] [template]
 *                                                    (default 8794, dream-sandbox)
 *
 * The control plane runs here, as in the tests (`test/support/Cloud.ts`): the Worker's handlers and the ProjectDOs on
 * node:sqlite, with APNs and both sign-ins faked (Claude's setup-token, Codex's device code). Only dreamd is real:
 * E2B is faked for the ProjectDOs, and every call one makes to dreamd goes to a real sandbox for its project's
 * harness, with the env file the ProjectDO wrote copied in. There Claude Code talks to fake-anthropic and Codex to
 * fake-responses (whose rate-limit headers dreamd reports as the ChatGPT plan's usage), and dreamd calls back here,
 * each project under its own path so the stand-in knows whose token to add.
 *
 * With both plans connected it starts a project on each, and checks each turn ran on its own harness and model
 * server with its own plan's credential, and that Codex's usage lands on the ChatGPT plan only. Then it removes
 * ChatGPT: the Codex project's next message waits and reaches no model while the Claude project carries on, and
 * connecting ChatGPT again delivers what waited. Last, ChatGPT's limit pauses only the Codex project. The sandboxes
 * are dev sandboxes, killed at the end. Needs E2B_API_KEY, or an HTTPS proxy that adds it.
 */
import { createServer } from "node:http"
import { DaemonEnvFile, devSandboxMetadata, type Harness, type ProjectId, UpstreamFailure } from "@dream/domain"
import { type Context, DateTime, Effect, Layer, ManagedRuntime, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { ApiConfig } from "../src/Config.ts"
import { Daemon } from "../src/e2b/Daemon.ts"
import { E2B, type SandboxAccess } from "../src/e2b/E2B.ts"
import { Envd } from "../src/e2b/Envd.ts"
import { makeCloud } from "../test/support/Cloud.ts"
import { type FakeWorld, fakeServices } from "../test/support/Fakes.ts"

const [publicUrl, portArg = "8794", template = "dream-sandbox"] = process.argv.slice(2)
if (publicUrl === undefined) {
  console.error("Usage: node apps/api/scripts/two-plans-check.ts <exposed URL> [port] [template]")
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

// The real providers, for the real sandboxes.
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

const createSandbox = (harness: Harness) =>
  run(
    E2B.use((e2b) =>
      e2b.create({
        template,
        timeoutSeconds: 30 * 60,
        autoPause: false,
        envVars: {},
        metadata: devSandboxMetadata(`two-plans-check-${harness}`),
        rules: {}
      })
    )
  )
const sandboxes: Record<Harness, SandboxAccess> = {
  "claude-code": await createSandbox("claude-code"),
  codex: await createSandbox("codex")
}
for (const [harness, s] of Object.entries(sandboxes)) say(`${harness} sandbox ${s.sandboxId} (${template})`)
const killAll = () =>
  Promise.all(Object.values(sandboxes).map((s) => run(E2B.use((e2b) => e2b.kill(s.sandboxId))).catch(() => {})))

/** Each project's harness, and the fake model server its sandbox runs. */
const harnessOf = new Map<ProjectId, Harness>()
const fakeLog: Record<Harness, string> = {
  "claude-code": "/tmp/fakes/anthropic.log",
  codex: "/tmp/fakes/responses.log"
}

/** The env file as a project's ProjectDO last wrote it into its fake sandbox, made to fit the real one. */
const written = new Map<ProjectId, string>()
const syncEnv = (world: FakeWorld, projectId: ProjectId) =>
  Effect.gen(function* () {
    const fake = [...world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)
    const env = fake?.files.get(DaemonEnvFile)
    if (env === undefined || env === written.get(projectId)) return
    written.set(projectId, env)
    const harness = harnessOf.get(projectId)!
    const lines = env
      .trim()
      .split("\n")
      .map((line) =>
        line.startsWith("DREAM_API_URL=") ? `DREAM_API_URL=${JSON.stringify(`${apiUrl}/p/${projectId}`)}` : line
      )
    if (harness === "codex")
      lines.push(`DREAM_CODEX_BASE_URL=${JSON.stringify("http://127.0.0.1:18788/backend-api/codex")}`)
    yield* Effect.promise(() =>
      run(Envd.use((envd) => envd.writeFile(sandboxes[harness], DaemonEnvFile, `${lines.join("\n")}\n`)))
    )
    say(`wrote ${harness} dreamd's env file`)
  })
const toUpstream = (error: unknown) => new UpstreamFailure({ service: "dreamd", message: String(error) })
/** A ProjectDO's call to dreamd, sent to the real sandbox of the project whose fake sandbox it names. */
const viaReal = <A>(
  world: FakeWorld,
  fake: SandboxAccess,
  use: (daemon: Context.Service.Shape<typeof Daemon>, sandbox: SandboxAccess) => Effect.Effect<A, unknown>
) => {
  const projectId = world.sandboxes.get(fake.sandboxId)?.metadata.projectId as ProjectId
  const sandbox = sandboxes[harnessOf.get(projectId)!]
  return Effect.andThen(
    syncEnv(world, projectId),
    Effect.tryPromise({ try: () => run(Daemon.use((d) => use(d, sandbox))), catch: toUpstream })
  )
}
const bridge = (world: FakeWorld) =>
  Layer.succeed(
    Daemon,
    Daemon.of({
      deliver: (s, token, events, timeZone) => viaReal(world, s, (d, r) => d.deliver(r, token, events, timeZone)),
      forwardRelay: (s, token, request) => viaReal(world, s, (d, r) => d.forwardRelay(r, token, request)),
      setWatching: (s, token, watching) => viaReal(world, s, (d, r) => d.setWatching(r, token, watching)),
      holdTurns: (s, token, held) => viaReal(world, s, (d, r) => d.holdTurns(r, token, held)),
      health: (s, token) => viaReal(world, s, (d, r) => d.health(r, token))
    })
  )

const program = async () => {
  for (const [harness, sandbox] of Object.entries(sandboxes) as Array<[Harness, SandboxAccess]>) {
    await sh(sandbox, "mkdir -p /tmp/fakes /home/user/.claude")
    if (harness === "claude-code")
      await run(
        Envd.use((envd) =>
          envd.writeFile(
            sandbox,
            "/home/user/.claude/settings.json",
            JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18789" } })
          )
        )
      )
    const server = harness === "claude-code" ? "fake-anthropic.ts 18789" : "fake-responses.ts 18788"
    await run(
      Envd.use((envd) =>
        envd.startBackground(sandbox, { command: `node ${scripts}/${server} > ${fakeLog[harness]} 2>&1` })
      )
    )
  }
  const modelRequests = async (harness: Harness) =>
    Number(await sh(sandboxes[harness], `grep -c '"model"' ${fakeLog[harness]} || true`))

  const cloud = await Effect.runPromise(
    makeCloud(
      { apiUrl, apiHost: new URL(apiUrl).host, sandboxRefresh: false, sandboxTemplate: template },
      { services: (world) => Layer.merge(fakeServices(world), bridge(world)) }
    )
  )

  // The stand-in API: /p/<project>/sandbox/rpc, with that project's token when the port proxy dropped it.
  const server = createServer(async (req, res) => {
    try {
      const chunks: Array<Uint8Array> = []
      for await (const chunk of req) chunks.push(chunk)
      const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      chunks.reduce((offset, c) => (body.set(c, offset), offset + c.length), 0)
      const match = /^\/p\/([^/]+)(\/.*)$/.exec((req.url ?? "/").replace(/\/+$/, ""))
      const projectId = match?.[1] as ProjectId | undefined
      const path = match?.[2] ?? req.url ?? "/"
      const headers = Object.entries(req.headers).flatMap(([k, v]) =>
        typeof v === "string" && !["host", "content-length", "connection", "transfer-encoding"].includes(k)
          ? [[k, v] as [string, string]]
          : []
      )
      if (!headers.some(([k]) => k === "authorization") && projectId !== undefined)
        headers.push(["authorization", `Bearer ${envValue(projectId, "DREAM_PROJECT_TOKEN")}`])
      const request = new Request(`${apiUrl}${path}`, {
        method: req.method ?? "GET",
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body })
      })
      const response =
        path === "/sandbox/rpc" ? await cloud.sandboxHandler(request) : new Response("not here", { status: 404 })
      const out = new Uint8Array(await response.arrayBuffer())
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "text/plain" })
      res.end(out)
    } catch (error) {
      say(`stand-in failed: ${String(error)}`)
      res.writeHead(500, { "content-type": "text/plain" })
      res.end(new TextEncoder().encode(String(error)))
    }
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

  // Both sign-ins, faked: Claude's setup-token, and Codex's device code and the auth file it writes.
  const claudeUrl =
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
  cloud.world.scripts.set("claude setup-token", [
    { _tag: "Output", text: `Use the url below\r\n${claudeUrl}\r\n` },
    { _tag: "Output", text: "Paste code here if prompted > " }
  ])
  const startedClaude = await Effect.runPromise(phone.StartModelConnection({ provider: "claude" }))
  cloud.world.attachOutput = [
    { _tag: "Output", text: "Long-lived authentication token created successfully!\r\n" },
    { _tag: "Output", text: `sk-ant-oat01-${"x".repeat(60)}\r\n` }
  ]
  await Effect.runPromise(
    phone.CompleteModelConnection({ connectionId: startedClaude.connection.id, code: Redacted.make("code#state") })
  )
  const connectChatGpt = async () => {
    cloud.world.scripts.set("codex login", [
      { _tag: "Output", text: "1. Open https://auth.openai.com/codex/device\n2. Enter WXYZ-12345\n" }
    ])
    const started = await Effect.runPromise(phone.StartModelConnection({ provider: "chatgpt" }))
    const auth = [...cloud.world.sandboxes.values()].findLast((s) => s.metadata.connectionId === started.connection.id)!
    auth.files.set(
      "/home/user/.codex/auth.json",
      JSON.stringify({ tokens: { id_token: "id", access_token: "fake-chatgpt", refresh_token: "r", account_id: "a" } })
    )
    return Effect.runPromise(phone.GetModelConnection({ connectionId: started.connection.id }))
  }
  const chatgpt = await connectChatGpt()
  const plans = await Effect.runPromise(phone.ListModelConnections())
  check(
    "both plans connected",
    plans.filter((c) => c.status === "connected").length === 2,
    plans.map((c) => `${c.provider}:${c.status}`).join(", ")
  )

  const onClaude = await Effect.runPromise(phone.CreateProject({ idea: "Say hello.", harness: "claude-code" }))
  const onCodex = await Effect.runPromise(phone.CreateProject({ idea: "Say hello.", harness: "codex" }))
  harnessOf.set(onClaude.id, "claude-code")
  harnessOf.set(onCodex.id, "codex")

  // workerd fires the ProjectDOs' alarms; here a ticker does, once a second.
  let ticking = false
  const ticker = setInterval(() => {
    if (ticking) return
    ticking = true
    Promise.all([onClaude.id, onCodex.id].map((id) => Effect.runPromise(cloud.alarm(id))))
      .catch((error) => say(`alarm failed: ${String(error)}`))
      .finally(() => {
        ticking = false
      })
  }, 1000)

  const turns = (projectId: ProjectId) =>
    (
      cloud.db.prepare("SELECT COUNT(*) AS n FROM turn_usage WHERE project_id = ?").all(projectId) as Array<{
        n: number
      }>
    )[0]!.n
  const summary = async (projectId: ProjectId) =>
    (await Effect.runPromise(phone.ListProjects())).find((s) => s.project.id === projectId)
  const until = async (what: string, test: () => Promise<boolean> | boolean, seconds = 180) => {
    for (let i = 0; i < seconds; i++) {
      if (await test()) return true
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    say(`gave up waiting: ${what}`)
    return false
  }
  const fakeOf = (projectId: ProjectId) =>
    [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  function envValue(projectId: ProjectId, name: string): string {
    return JSON.parse(
      fakeOf(projectId)
        .files.get(DaemonEnvFile)!
        .split("\n")
        .find((line) => line.startsWith(`${name}=`))!
        .slice(name.length + 1)
    ) as string
  }

  // A project on each plan: each turn on its own harness, model server and credential.
  const firstTurns = await until("a first turn on each", () => turns(onClaude.id) >= 1 && turns(onCodex.id) >= 1)
  check("a turn ran on each harness's real dreamd", firstTurns, `${turns(onClaude.id)} / ${turns(onCodex.id)}`)
  if (!firstTurns) {
    for (const [harness, s] of Object.entries(sandboxes))
      say(`${harness} dreamd log:\n${await sh(s, `tail -30 ${log}`)}`)
    throw new Error("no first turns")
  }
  check(
    "Claude Code reached fake-anthropic and Codex fake-responses",
    (await modelRequests("claude-code")) > 0 && (await modelRequests("codex")) > 0
  )
  const ledger = cloud.db.prepare("SELECT project_id, provider FROM turn_usage").all() as Array<{
    project_id: string
    provider: string
  }>
  check(
    "each turn is counted on its own plan",
    ledger.every((row) => row.provider === (row.project_id === onCodex.id ? "chatgpt" : "claude")),
    JSON.stringify(ledger)
  )
  const rules = (projectId: ProjectId) => Object.keys(fakeOf(projectId).rules)
  check(
    "each sandbox carries only its own plan's credential",
    rules(onClaude.id).includes("api.anthropic.com") &&
      !rules(onClaude.id).includes("chatgpt.com") &&
      rules(onCodex.id).includes("chatgpt.com") &&
      !rules(onCodex.id).includes("api.anthropic.com"),
    `${rules(onClaude.id).join(",")} / ${rules(onCodex.id).join(",")}`
  )
  const chatgptUsage = await Effect.runPromise(phone.GetAccountUsage({ provider: "chatgpt" }).pipe(Effect.option))
  const claudeUsage = await Effect.runPromise(phone.GetAccountUsage({ provider: "claude" }).pipe(Effect.option))
  check(
    "Codex's usage reading went to the ChatGPT plan, not Claude's",
    Option.isSome(chatgptUsage) &&
      chatgptUsage.value.weekly?.usedPercent === 12 &&
      (Option.isNone(claudeUsage) || claudeUsage.value.weekly?.usedPercent !== 12),
    JSON.stringify({
      chatgpt: Option.getOrUndefined(chatgptUsage)?.weekly,
      claude: Option.getOrUndefined(claudeUsage)?.weekly
    })
  )

  // Removing ChatGPT: the Codex project's message waits; the Claude project carries on.
  await until("both turns to end", async () =>
    [onClaude.id, onCodex.id].every((id) => fakeOf(id) !== undefined)
      ? (await Promise.all([summary(onClaude.id), summary(onCodex.id)])).every((s) => s?.activity?.state === "idle")
      : false
  )
  await Effect.runPromise(phone.DisconnectModelConnection({ connectionId: chatgpt.id }))
  const codexBefore = await modelRequests("codex")
  const codexTurns = turns(onCodex.id)
  await Effect.runPromise(phone.SendMessage({ projectId: onCodex.id, text: "Are you there?" }))
  await Effect.runPromise(phone.SendMessage({ projectId: onClaude.id, text: "Are you there?" }))
  const claudeGoesOn = await until("the Claude project's next turn", () => turns(onClaude.id) >= 2)
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  check("the Claude project carries on", claudeGoesOn)
  const waiting = await summary(onCodex.id)
  check(
    "the Codex project's message waits and reaches no model",
    (await modelRequests("codex")) === codexBefore && turns(onCodex.id) === codexTurns,
    `activity ${waiting?.activity?.state}`
  )

  // Connected again, what waited is delivered.
  await connectChatGpt()
  check(
    "connecting ChatGPT again delivers what waited",
    await until("the Codex project's next turn", () => turns(onCodex.id) > codexTurns),
    `${await modelRequests("codex")} Codex model requests`
  )

  // ChatGPT's limit pauses only the project on ChatGPT.
  const dreamd = await Effect.runPromise(cloud.sandbox(envValue(onCodex.id, "DREAM_PROJECT_TOKEN")))
  await Effect.runPromise(
    dreamd.ReportUsage({
      usage: {
        provider: "chatgpt",
        fiveHour: { usedPercent: 100 },
        limitedUntil: { window: "fiveHour", until: DateTime.add(DateTime.nowUnsafe(), { hours: 2 }) },
        observedAt: DateTime.nowUnsafe()
      }
    })
  )
  await new Promise((resolve) => setTimeout(resolve, 2000))
  check(
    "ChatGPT's limit pauses only the Codex project",
    (await summary(onCodex.id))?.pausedUntil !== undefined && (await summary(onClaude.id))?.pausedUntil === undefined
  )

  clearInterval(ticker)
  await Effect.runPromise(cloud.close)
}

try {
  await program()
} catch (error) {
  check("the check ran to the end", false, String(error))
} finally {
  await killAll()
  say("sandboxes killed")
}
const failed = results.filter((r) => !r.ok)
say(failed.length === 0 ? `all ${results.length} checks passed` : `${failed.length} of ${results.length} checks failed`)
process.exit(failed.length === 0 ? 0 : 1)
