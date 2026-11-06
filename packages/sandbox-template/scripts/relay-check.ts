/**
 * Checks on real E2B (and, for relays, a real workerd) what unit tests can only fake, against stand-ins that run
 * where this script does, so no project or account is touched:
 *
 *   node scripts/relay-check.ts api [port]          the stand-in Worker (default port 8790): answers dreamd's
 *                                                   `SandboxRpcs`; on `StayAwake` it sets the sandbox's timeout and
 *                                                   on `Sleep` it pauses the sandbox, as the ProjectDO does. Expose it.
 *   node scripts/relay-check.ts sleep <api url>     a 5-second scheduled command: the sandbox goes back to sleep
 *                                                   seconds after it, not five minutes
 *   node scripts/relay-check.ts relay <api url> <probe url> <fake discord url> <probe key> [probe name]
 *                                                   a relay running in a throwaway Worker (apps/api/scripts/
 *                                                   relay-probe.ts) holds a fake Discord's Gateway open
 *                                                   (apps/api/scripts/fake-discord.ts) and delivers its messages to
 *                                                   an app in a sandbox: awake, asleep (the delivery wakes it, and
 *                                                   it sleeps again after), across a dropped line, and across a
 *                                                   redeploy of the Worker when a probe name is given
 *
 * Each scenario creates a sandbox of the template (DREAM_TEMPLATE) the way the ProjectDO does, sets dreamd up
 * against the stand-in, and kills it at the end. The project token is the sandbox's id, which is how the stand-in
 * knows which sandbox to keep up or put to sleep.
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import {
  CurrentProject,
  DaemonEnvFile,
  DefaultDaemonPort,
  DiscordDefaultIntents,
  HttpRpcSerialization,
  type ProjectId,
  Routes,
  SandboxAuth,
  SandboxRpcs,
  Unauthorized,
  type UserId
} from "@dream/domain"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Sandbox } from "e2b"
import { Effect, Layer, Option } from "effect"
import { Headers, HttpRouter } from "effect/http"
import { RpcServer } from "effect/rpc"
import { templateName } from "../src/index.ts"

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}
const IdleMs = 5 * 60_000
const appPort = 3000
const stamp = () => new Date().toISOString().slice(11, 19)
const say = (line: string) => console.log(`${stamp()} ${line}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// The stand-in Worker
// ---------------------------------------------------------------------------

const stayAwake = async (sandboxId: string, reason: string) => {
  const info = await Sandbox.getInfo(sandboxId, connection)
  if (info.state !== "running") return say(`StayAwake ${reason}: ${info.state}, left alone`)
  if (info.endAt.getTime() >= Date.now() + IdleMs) return say(`StayAwake ${reason}: already up long enough`)
  await Sandbox.setTimeout(sandboxId, IdleMs, connection)
  say(`StayAwake ${reason}: up until 5 minutes from now`)
}

/** What the ProjectDO's `sleep` does, for a sandbox with no turns or events of its own. */
const putToSleep = async (sandboxId: string, reason: string) => {
  const info = await Sandbox.getInfo(sandboxId, connection)
  if (info.state !== "running") return say(`Sleep ${reason}: ${info.state}, left alone`)
  await Sandbox.pause(sandboxId, connection)
  say(`Sleep ${reason}: paused it`)
}

const api = (port: number) => {
  const handlers = SandboxRpcs.toLayer(
    new Proxy({} as never, {
      get: (_, tag: string) => (payload: { readonly reason?: string }) =>
        Effect.gen(function* () {
          const { projectId } = yield* CurrentProject
          const reason = payload.reason ?? "?"
          if (tag === "StayAwake") {
            return yield* Effect.promise(() => stayAwake(projectId, reason).catch((e) => say(`StayAwake failed: ${e}`)))
          }
          if (tag === "Sleep") {
            return yield* Effect.promise(() => putToSleep(projectId, reason).catch((e) => say(`Sleep failed: ${e}`)))
          }
          say(`${tag} from ${projectId}`)
          return undefined
        })
    })
  )
  const auth = Layer.succeed(SandboxAuth, (effect, { headers }) =>
    Option.match(Headers.get(headers, "authorization"), {
      onNone: () => Effect.fail(new Unauthorized({ message: "no project token" })),
      onSome: (bearer) =>
        Effect.provideService(effect, CurrentProject, {
          projectId: bearer.replace(/^Bearer /, "") as ProjectId,
          userId: "usr_check" as UserId
        })
    })
  )
  say(`stand-in Worker on :${port}`)
  HttpRouter.serve(
    RpcServer.layerHttp({ group: SandboxRpcs, path: Routes.sandbox, protocol: "http" }).pipe(
      Layer.provide([handlers, auth, HttpRpcSerialization])
    ),
    { disableLogger: true, disableListenLog: true }
  ).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port, host: "0.0.0.0" })),
    Layer.launch,
    NodeRuntime.runMain
  )
}

// ---------------------------------------------------------------------------
// A project sandbox
// ---------------------------------------------------------------------------

/** The app: takes relay deliveries on /hooks/discord, checks each signature with the relay key, and logs them. */
const app = `import { createHmac, timingSafeEqual } from "node:crypto"
import { appendFileSync, readFileSync } from "node:fs"
Bun.serve({
  port: ${appPort},
  async fetch(req) {
    if (new URL(req.url).pathname !== "/hooks/discord") return new Response("hello\\n")
    const body = await req.text()
    const key = readFileSync("/home/user/.dream/relay.key", "utf8").trim()
    const timestamp = req.headers.get("dream-timestamp") ?? ""
    const expected = "v1=" + createHmac("sha256", key).update(timestamp + "." + body).digest("hex")
    const given = req.headers.get("dream-signature") ?? ""
    const verified = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300
    const delivery = JSON.parse(body)
    appendFileSync("/home/user/project/deliveries.log", JSON.stringify({
      id: req.headers.get("dream-delivery"), verified, fresh, content: delivery.data?.content, at: new Date().toISOString()
    }) + "\\n")
    return verified && fresh ? new Response("ok") : new Response("bad signature", { status: 401 })
  }
})
`

const run = async (sandbox: Sandbox, command: string, timeoutMs = 120_000) => {
  const result = await sandbox.commands
    .run(command, { timeoutMs })
    .catch((error: { result?: { stdout: string; stderr: string; exitCode: number } }) => {
      if (error.result === undefined) throw error
      return error.result
    })
  return `${result.stdout}${result.stderr}`.trim()
}

const setup = async (apiUrl: string) => {
  const sandbox = await Sandbox.create(templateName, {
    ...connection,
    timeoutMs: IdleMs,
    lifecycle: { onTimeout: "pause", autoResume: true },
    network: { allowPublicTraffic: false },
    metadata: { purpose: "relay-check" }
  })
  const daemonToken = randomBytes(20).toString("hex")
  say(`sandbox ${sandbox.sandboxId} from ${templateName}`)
  try {
    await sandbox.files.write("/home/user/project/app.ts", app)
    await run(sandbox, "cd /home/user/project; setsid nohup bun app.ts > app.log 2>&1 < /dev/null &")
    await sandbox.files.write(
      DaemonEnvFile,
      [
        `DREAM_API_URL=${apiUrl}`,
        "DREAM_PROJECT_ID=prj_check",
        `DREAM_PROJECT_TOKEN=${sandbox.sandboxId}`,
        `DREAM_DAEMON_TOKEN=${daemonToken}`,
        "DREAM_HARNESS=claude-code",
        ""
      ].join("\n")
    )
    say(
      await run(
        sandbox,
        'for i in $(seq 1 30); do grep -q "dreamd started" ~/.dream/logs/dreamd.log && break; sleep 1; done; grep -c "dreamd started" ~/.dream/logs/dreamd.log; ls -l ~/.dream/relay.key | cut -c1-10'
      )
    )
  } catch (error) {
    await sandbox.kill()
    throw error
  }
  return { sandbox, daemonToken, traffic: sandbox.trafficAccessToken ?? "", domain: sandbox.sandboxDomain ?? "e2b.app" }
}

const state = async (sandboxId: string) => (await Sandbox.getInfo(sandboxId, connection)).state

/** Polls until `check` says yes, every `everyMs`, for up to `withinMs`; returns how long it took, or undefined. */
const until = async (check: () => Promise<boolean>, withinMs: number, everyMs = 1000) => {
  const started = Date.now()
  while (Date.now() - started < withinMs) {
    if (await check().catch(() => false)) return Date.now() - started
    await sleep(everyMs)
  }
  return undefined
}

const scenarios: Record<string, (args: ReadonlyArray<string>) => Promise<boolean>> = {
  sleep: async ([apiUrl]) => {
    const { sandbox, daemonToken, traffic, domain } = await setup(apiUrl!)
    try {
      await sleep(70_000) // Past the first minute, so the look that follows sees no recent use.
      const deliver = fileURLToPath(new URL("../../dreamd/scripts/deliver.ts", import.meta.url))
      const origin = `https://${DefaultDaemonPort}-${sandbox.sandboxId}.${domain}`
      const sent = Date.now()
      say(
        execFileSync("node", [deliver, origin, daemonToken, "wake", "check", "sleep 5; echo checked"], {
          env: { ...process.env, E2B_TRAFFIC_TOKEN: traffic },
          encoding: "utf8"
        }).trim()
      )
      const took = await until(async () => (await state(sandbox.sandboxId)) === "paused", 4 * 60_000, 1000)
      say(
        took === undefined
          ? "still running after 4 minutes"
          : `paused ${(took / 1000).toFixed(1)} s after the wake was delivered`
      )
      const log = await run(
        sandbox,
        "grep -h 'Scheduled command\\|asking to sleep\\|Nothing left' ~/.dream/logs/dreamd.log | cut -c1-160"
      )
      say(`dreamd:\n${log}`)
      return took !== undefined && took < 30_000 && Date.now() - sent > 5_000
    } finally {
      await sandbox.kill()
      say("killed")
    }
  },

  relay: async ([apiUrl, probeUrl, discordUrl, probeKey, probeName]) => {
    // Each run gets a fresh object, so nothing an earlier run left behind counts.
    const relayId = `rly_check_${randomBytes(4).toString("hex")}`
    const probe = (path: string, init?: RequestInit) =>
      fetch(`${probeUrl}${path}${path.includes("?") ? "&" : "?"}key=${probeKey}&relay=${relayId}`, init).then(
        async (response) => ({ status: response.status, body: (await response.json()) as any })
      )
    const control = (path: string, body: unknown = {}) =>
      fetch(`${discordUrl}/control/${path}`, { method: "POST", body: JSON.stringify(body) }).then(
        (r) => r.json() as any
      )
    const discordState = () => fetch(`${discordUrl}/control/state`).then((r) => r.json() as any)
    const { sandbox, daemonToken, traffic, domain } = await setup(apiUrl!)
    let ok = true
    const expect = (what: string, holds: boolean) => {
      say(`${holds ? "✓" : "✗"} ${what}`)
      ok &&= holds
    }
    const deliveries = async () =>
      (await run(sandbox, "cat /home/user/project/deliveries.log 2>/dev/null || true"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { id: string; verified: boolean; fresh: boolean; content: string })
    const delivered = async () => (await probe("/probe/status")).body.delivered as number
    try {
      await probe("/probe/target", {
        method: "POST",
        body: JSON.stringify({
          sandboxId: sandbox.sandboxId,
          domain,
          trafficAccessToken: traffic,
          daemonToken,
          port: appPort,
          path: "/hooks/discord"
        })
      })
      const started = await probe("/probe/start", {
        method: "POST",
        body: JSON.stringify({
          relayId,
          projectId: "prj_check",
          source: { _tag: "Discord", intents: DiscordDefaultIntents, events: ["MESSAGE_CREATE"], mentionsOnly: false },
          target: { path: "/hooks/discord", port: appPort },
          createdAt: new Date().toISOString()
        })
      })
      say(`started: ${started.status} ${started.body.state}`)
      const connected = await until(async () => (await probe("/probe/status")).body.state === "connected", 60_000)
      expect(`the relay connected and logged in (${connected} ms)`, connected !== undefined)
      say(`fake Discord saw: ${JSON.stringify((await discordState()).calls)}`)

      // 1. Awake.
      for (const content of ["one", "two"]) await control("message", { content })
      const awake = await until(async () => (await delivered()) >= 2, 60_000)
      const first = await deliveries()
      expect(
        `two messages reached the app (${awake} ms), signed and fresh`,
        first.length === 2 &&
          first.every((d) => d.verified && d.fresh) &&
          first.map((d) => d.content).join() === "one,two"
      )

      // 2. Asleep: the delivery wakes it, and it goes back to sleep after.
      await Sandbox.pause(sandbox.sandboxId, connection)
      expect("the sandbox is paused", (await state(sandbox.sandboxId)) === "paused")
      const sentAt = Date.now()
      await control("message", { content: "while asleep" })
      const woke = await until(async () => (await delivered()) >= 3, 60_000, 500)
      expect(`a message sent while it slept was delivered (${woke} ms)`, woke !== undefined)
      say(`it took ${((Date.now() - sentAt) / 1000).toFixed(1)} s from the message to the app answering`)
      const slept = await until(async () => (await state(sandbox.sandboxId)) === "paused", 90_000, 1000)
      expect(`it went back to sleep after the delivery (${slept} ms)`, slept !== undefined)

      // 3. A dropped line: the relay resumes, and Discord replays what it missed.
      await control("drop")
      await control("message", { content: "while the line was down" })
      const resumed = await until(async () => (await delivered()) >= 4, 90_000)
      const calls = (await discordState()).calls as Array<string>
      expect(
        `it resumed after the line dropped (${resumed} ms)`,
        resumed !== undefined && calls.some((c) => c.startsWith("resume"))
      )

      // 4. A redeploy of the Worker. Cloudflare moves an object holding an open socket to the new code a few minutes
      //    later, dropping the line; the new object resumes the stored session, and Discord replays what it missed.
      //    A message every 15 s until then, and two after.
      if (probeName !== undefined) {
        const connects = async () =>
          ((await discordState()).calls as Array<string>).filter((c) => c === "connect").length
        const resumes = async () =>
          ((await discordState()).calls as Array<string>).filter((c) => c.startsWith("resume")).length
        const before = { connects: await connects(), resumes: await resumes(), delivered: await delivered() }
        const deploy = fileURLToPath(new URL("../../../apps/api/scripts/relay-probe.ts", import.meta.url))
        say(execFileSync("node", [deploy, "deploy", probeName], { encoding: "utf8" }).trim().split("\n").at(-1) ?? "")
        const deployedAt = Date.now()
        let sent = 0
        while (Date.now() - deployedAt < 8 * 60_000 && (await connects()) === before.connects) {
          await control("message", { content: `around the redeploy ${++sent}` })
          await sleep(15_000)
        }
        const restarted = (await connects()) > before.connects
        say(
          restarted
            ? `the object restarted ${((Date.now() - deployedAt) / 1000).toFixed(0)} s after the deploy`
            : "no restart within 8 minutes"
        )
        for (const content of ["after the restart 1", "after the restart 2"]) await control("message", { content })
        sent += 2
        const after = await until(async () => (await delivered()) >= before.delivered + sent, 2 * 60_000, 2000)
        expect(
          `the object restarted, resumed its session, and delivered all ${sent} messages sent around it (${after} ms)`,
          restarted && (await resumes()) > before.resumes && after !== undefined
        )
      }

      // Exactly once, all signed.
      const all = await deliveries()
      const ids = new Set(all.filter((d) => d.verified).map((d) => d.id))
      say(`the app logged: ${all.map((d) => `${d.content}${d.verified ? "" : " (unverified)"}`).join(" | ")}`)
      expect(
        `every delivery was verified, none twice (${ids.size} distinct of ${all.length})`,
        all.every((d) => d.verified) && ids.size === all.length
      )
      say(`relay status: ${JSON.stringify((await probe("/probe/status")).body)}`)
      say(`alerts: ${JSON.stringify((await probe("/probe/alerts")).body)}`)
      await probe("/probe/stop", { method: "POST" })
      const closed = await until(async () => (await discordState()).connected === 0, 30_000)
      expect("stopping closed the line", closed !== undefined)
      return ok
    } finally {
      await sandbox.kill()
      say("killed")
    }
  }
}

const [mode, ...rest] = process.argv.slice(2)
if (mode === "api") api(Number(rest[0] ?? 8790))
else if (mode !== undefined && mode in scenarios) {
  const passed = await scenarios[mode]!(rest)
  say(passed ? "PASSED" : "FAILED")
  process.exit(passed ? 0 : 1)
} else {
  console.error(
    "usage: relay-check.ts api [port] | sleep <api url> | relay <api url> <probe url> <discord url> <key> [probe name]"
  )
  process.exit(2)
}
