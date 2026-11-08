/**
 * Checks `dream email` end to end with the real `dream` CLI and dreamd on real E2B, against the fake model server
 * that ships in the template and a fake mailer, so no account, project, subscription or inbox is touched:
 *
 *   ol expose 8794                                   (the sandbox's dreamd reaches the stand-in API through it)
 *   NODE_USE_ENV_PROXY=1 node apps/api/scripts/email-check.ts <exposed URL> [port] [template]
 *                                                    (default 8794, dream-sandbox)
 *
 * The control plane runs here, as in the tests (`test/support/Cloud.ts`): the Worker's handlers and a ProjectDO on
 * node:sqlite, with APNs, the model connection and Cloudflare's email binding faked (what it was asked to send is
 * kept in memory). Only dreamd and the CLI are real, in a dev sandbox of the template, killed at the end.
 *
 * A turn runs `dream email --file` (the agent's way), and the check reads what the fake mailer got and the copy in
 * Chat, and that the turn posted nothing else. Then the CLI is run directly: a bad flag sends nothing, a failed send
 * says so and leaves no copy, and the daily limit stops the eleventh email with a line that explains it. Needs
 * E2B_API_KEY, or an HTTPS proxy that adds it.
 */
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { AgentEmailLimits, DaemonEnvFile, devSandboxMetadata, type TextMessage, UpstreamFailure } from "@dream/domain"
import { type Context, Effect, Layer, ManagedRuntime, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { ApiConfig } from "../src/Config.ts"
import { Daemon } from "../src/e2b/Daemon.ts"
import { E2B, type SandboxAccess } from "../src/e2b/E2B.ts"
import { Envd } from "../src/e2b/Envd.ts"
import { makeCloud } from "../test/support/Cloud.ts"
import { type FakeWorld, fakeServices } from "../test/support/Fakes.ts"

const [publicUrl, portArg = "8794", template = "dream-sandbox"] = process.argv.slice(2)
if (publicUrl === undefined) {
  console.error("Usage: node apps/api/scripts/email-check.ts <exposed URL> [port] [template]")
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
      metadata: devSandboxMetadata("email-check"),
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
    const env = [...world.sandboxes.values()].find((s) => s.files.has(DaemonEnvFile))?.files.get(DaemonEnvFile)
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
const bridge = (world: FakeWorld) =>
  Layer.succeed(
    Daemon,
    Daemon.of({
      deliver: (_s, token, events, timeZone) => viaReal(world, (d) => d.deliver(sandbox, token, events, timeZone)),
      forwardRelay: (_s, token, request) => viaReal(world, (d) => d.forwardRelay(sandbox, token, request)),
      setWatching: (_s, token, watching) => viaReal(world, (d) => d.setWatching(sandbox, token, watching)),
      holdTurns: (_s, token, held) => viaReal(world, (d) => d.holdTurns(sandbox, token, held)),
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

  const cloud = await Effect.runPromise(
    makeCloud(
      { apiUrl, apiHost: new URL(apiUrl).host, sandboxRefresh: false, sandboxTemplate: template },
      { services: (world) => Layer.merge(fakeServices(world), bridge(world)) }
    )
  )
  let projectToken = (): string => ""
  const server = createServer(async (req, res) => {
    try {
      const chunks: Array<Uint8Array> = []
      for await (const chunk of req) chunks.push(chunk)
      const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      chunks.reduce((offset, c) => (body.set(c, offset), offset + c.length), 0)
      const headers = Object.entries(req.headers).flatMap(([k, v]) =>
        typeof v === "string" && !["host", "content-length", "connection", "transfer-encoding"].includes(k)
          ? [[k, v] as [string, string]]
          : []
      )
      // E2B's port proxy drops Authorization on the way in; the project's token is the only one dreamd sends.
      if (!headers.some(([k]) => k === "authorization")) headers.push(["authorization", `Bearer ${projectToken()}`])
      const request = new Request(`${apiUrl}${(req.url ?? "/").replace(/\/+$/, "")}`, {
        method: req.method ?? "GET",
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body })
      })
      const response =
        new URL(request.url).pathname === "/sandbox/rpc"
          ? await cloud.sandboxHandler(request)
          : new Response("not here", { status: 404 })
      const out = new Uint8Array(await response.arrayBuffer())
      if (process.env.CHECK_DEBUG)
        say(
          `stand-in ${req.method} ${req.url} ${body.length}B → ${response.status} ${out.length}B ${JSON.stringify(headers)} ${new TextDecoder().decode(body.slice(0, 160))}`
        )
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
  const project = await Effect.runPromise(phone.CreateProject({ idea: "Tide Clock, an app for the tides." }))
  projectToken = () => envValue("DREAM_PROJECT_TOKEN")

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
  const agentTexts = async () =>
    (await Effect.runPromise(phone.ListMessages({ projectId: project.id }))).messages.filter(
      (m): m is TextMessage => m._tag === "Text" && m.from === "agent"
    )
  const until = async (what: string, test: () => Promise<boolean> | boolean, seconds = 180) => {
    for (let i = 0; i < seconds; i++) {
      if (await test()) return true
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    say(`gave up waiting: ${what}`)
    return false
  }
  const fake = () => [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === project.id)!
  const envValue = (name: string) =>
    JSON.parse(
      fake()
        .files.get(DaemonEnvFile)!
        .split("\n")
        .find((line) => line.startsWith(`${name}=`))!
        .slice(name.length + 1)
    ) as string
  const first = await until("the first turn", () => turns() >= 1)
  check("the first turn ran on the real dreamd", first)
  if (!first) {
    say(`dreamd log:\n${await sh(sandbox, `tail -40 ${log}`)}`)
    throw new Error("no first turn")
  }
  await until("the first turn to end", async () => (await summary())?.activity?.state !== "working", 120)

  // The agent's way: a turn runs `dream email --file`.
  const walkthrough = readFileSync(new URL("../test/fixtures-apple-walkthrough.md", import.meta.url), "utf8")
  await run(Envd.use((envd) => envd.writeFile(sandbox, "/tmp/steps.md", walkthrough)))
  const before = (await agentTexts()).length
  const turnsBefore = turns()
  await Effect.runPromise(
    phone.SendMessage({
      projectId: project.id,
      text: `RUN: dream email --subject "Set up Tide Clock in Apple Developer" --file /tmp/steps.md`
    })
  )
  check("the turn sent the email", await until("the email", () => cloud.mail.sent.length >= 1))
  const mail = cloud.mail.sent[0]
  check(
    "to the owner's address, from Dream",
    mail?.to === "check@example.com" && mail.from.name === "Dream",
    `${mail?.to} from ${mail?.from.email}`
  )
  check("with the subject", mail?.subject === "Set up Tide Clock in Apple Developer")
  check(
    "rendered: headings, numbered steps, a link with its host, the code block",
    mail !== undefined &&
      mail.html.includes("<h3") &&
      mail.html.includes("<ol") &&
      mail.html.includes('href="https://developer.apple.com/account/resources/identifiers/list"') &&
      mail.html.includes("(developer.apple.com)") &&
      mail.html.includes("Team ID: 7XQ2K9LM4P")
  )
  check("with the markdown as its plain-text part", mail?.text.includes("## 1. Register the app's identifier") === true)
  await until("the turn to finish", () => turns() > turnsBefore, 120)
  const after = await agentTexts()
  const copy = after.find((m) => m.email !== undefined)
  check(
    "Chat has the copy, marked as emailed",
    copy?.email?.subject === "Set up Tide Clock in Apple Developer" && copy.text === walkthrough
  )
  check(
    "and nothing else from the turn (the email counts as reaching them)",
    after.length === before + 1,
    `${before} → ${after.length} agent messages`
  )

  // The CLI, run directly.
  const dream = async (args: string) => {
    const out = await sh(sandbox, `cd /tmp && dream email ${args} 2>&1; echo "exit=$?"`)
    return out
  }
  const badWork = await dream(`--subject "Steps" --work ws_nope "1. Open it"`)
  check(
    "a bad --work sends nothing and says why",
    badWork.includes("exit=1") && badWork.includes("no workstream") && cloud.mail.sent.length === 1,
    badWork.split("\n")[0]
  )
  const twoLines = await dream(`--subject $'one\\ntwo' "1. Open it"`)
  check(
    "a two-line subject is refused by the CLI",
    twoLines.includes("one line") && twoLines.includes("exit=1"),
    twoLines.split("\n")[0]
  )

  cloud.mail.failWith = "E_RECIPIENT_SUPPRESSED"
  const failed = await dream(`--subject "Steps" "1. Open it"`)
  cloud.mail.failWith = undefined
  check(
    "a failed send says so, and leaves no copy in Chat",
    failed.includes("exit=1") &&
      failed.includes("E_RECIPIENT_SUPPRESSED") &&
      (await agentTexts()).filter((m) => m.email).length === 1,
    failed.split("\n")[0]
  )

  // The failed send counted against the day's limit too; send up to it, then one more.
  const sentSoFar = cloud.mail.sent.length
  for (let i = sentSoFar + 1; i < AgentEmailLimits.perProjectPerDay; i++) {
    await sh(sandbox, `cd /tmp && printf '1. Step ${i}\\n' | dream email --subject "Steps ${i}" - 2>&1`)
  }
  const printed = await dream(`--subject "One more" "1. Open it"`)
  check(
    "the daily limit stops the next one, and the CLI explains it",
    printed.includes("exit=1") && printed.includes("emails it can in a day") && printed.includes("wasn't sent"),
    printed.split("\n")[0]
  )
  const ok = await dream(`--subject "x" "y"`)
  check("…and keeps stopping them", ok.includes("exit=1"))
  say(
    `mails sent: ${cloud.mail.sent.length}; emailed copies in Chat: ${(await agentTexts()).filter((m) => m.email).length}`
  )

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
