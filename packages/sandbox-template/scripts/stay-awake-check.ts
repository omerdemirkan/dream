/**
 * Checks on real E2B that a sandbox stays awake while dreamd has work between turns (`StayAwake`), against a
 * stand-in for the Worker that runs where this script does, so no project or account is touched:
 *
 *   node scripts/stay-awake-check.ts api [port]                the stand-in (default port 8790): answers dreamd's
 *                                                              `SandboxRpcs`, and on `StayAwake` sets the sandbox's
 *                                                              timeout the way the ProjectDO does. Expose it publicly.
 *   node scripts/stay-awake-check.ts command <api url>         a scheduled `--run` command of 7 minutes finishes
 *   node scripts/stay-awake-check.ts websocket <api url>       a WebSocket used for 8 minutes stays open
 *   node scripts/stay-awake-check.ts requests <api url>        requests every 40 s for 7 minutes keep the sandbox up,
 *                                                              and it sleeps a few minutes after the last one
 *   node scripts/stay-awake-check.ts loopback <api url>        a process in the sandbox polling its own app on
 *                                                              localhost doesn't keep it up
 *
 * Each scenario creates a sandbox of the template (DREAM_TEMPLATE) the way the ProjectDO does: a 5-minute timeout,
 * paused on timeout, resumed by traffic, private traffic. It sets dreamd and a small Bun app up, then leaves the
 * sandbox alone but for its traffic, watching E2B's state and end time, and kills it at the end. The project token
 * is the sandbox's id, which is how the stand-in knows whose timeout to set.
 */
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import {
  CurrentProject,
  DaemonEnvFile,
  DefaultDaemonPort,
  devSandboxMetadata,
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
/** As the ProjectDO's `AwakeTail`: each `StayAwake` keeps the sandbox up this long. */
const AwakeTailMs = 2 * 60_000
const appPort = 3000
const stamp = () => new Date().toISOString().slice(11, 19)
const say = (line: string) => console.log(`${stamp()} ${line}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// The stand-in Worker
// ---------------------------------------------------------------------------

/** What the ProjectDO's `stayAwake` does, but for archived projects and turns, which these sandboxes don't have. */
const stayAwake = async (sandboxId: string, reason: string) => {
  const info = await Sandbox.getInfo(sandboxId, connection)
  const until = Date.now() + AwakeTailMs
  if (info.state !== "running") return say(`StayAwake ${reason} ${sandboxId}: ${info.state}, left alone`)
  if (info.endAt.getTime() >= until)
    return say(`StayAwake ${reason} ${sandboxId}: already up until ${info.endAt.toISOString()}`)
  await Sandbox.setTimeout(sandboxId, AwakeTailMs, connection)
  say(`StayAwake ${reason} ${sandboxId}: ${info.endAt.toISOString()} -> 2 minutes from now`)
}

const api = (port: number) => {
  const handlers = SandboxRpcs.toLayer(
    new Proxy({} as never, {
      get: (_, tag: string) => (payload: { readonly reason?: string }) =>
        Effect.gen(function* () {
          const { projectId } = yield* CurrentProject
          if (tag === "StayAwake") {
            return yield* Effect.promise(() =>
              stayAwake(projectId, payload.reason ?? "?").catch((e) => say(`StayAwake failed: ${e}`))
            )
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

const app = `const server = Bun.serve({
  port: ${appPort},
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws" && server.upgrade(req)) return
    return new Response("hello at " + new Date().toISOString() + "\\n")
  },
  websocket: { message(ws, text) { ws.send("echo " + text) } }
})
console.log("listening on", server.port)
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

/** A sandbox as the ProjectDO makes one, running dreamd against the stand-in, with the app on `appPort`. */
const setup = async (apiUrl: string, options: { readonly published: boolean }) => {
  const sandbox = await Sandbox.create(templateName, {
    ...connection,
    timeoutMs: IdleMs,
    metadata: devSandboxMetadata("stay-awake-check"),
    lifecycle: { onTimeout: "pause", autoResume: true },
    network: { allowPublicTraffic: false }
  })
  const daemonToken = randomBytes(20).toString("hex")
  say(`sandbox ${sandbox.sandboxId} from ${templateName}`)
  await prepare(sandbox, apiUrl, daemonToken, options).catch(async (error) => {
    await sandbox.kill()
    say("killed")
    throw error
  })
  const origin = (port: number) => `https://${port}-${sandbox.sandboxId}.${sandbox.sandboxDomain ?? "e2b.app"}`
  return { sandbox, daemonToken, origin, traffic: sandbox.trafficAccessToken ?? "" }
}

const prepare = async (
  sandbox: Sandbox,
  apiUrl: string,
  daemonToken: string,
  options: { readonly published: boolean }
) => {
  await sandbox.files.write("/home/user/project/app.ts", app)
  if (options.published) {
    await sandbox.files.write("/home/user/.dream/state/published.json", JSON.stringify({ port: appPort }))
  }
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
      'for i in $(seq 1 30); do grep -q "dreamd started" ~/.dream/logs/dreamd.log && break; sleep 1; done; grep -c "dreamd started" ~/.dream/logs/dreamd.log; curl -s localhost:3000'
    )
  )
}

/** E2B's view, every 10 s, until `stop` says so; returns when it last saw the sandbox running. */
const watch = (sandboxId: string) => {
  let stopped = false
  let lastRunning = Date.now()
  let pausedAt: number | undefined
  let last = ""
  const done = (async () => {
    while (!stopped) {
      const info = await Sandbox.getInfo(sandboxId, { ...connection, requestTimeoutMs: 15_000 }).catch(() => undefined)
      if (info !== undefined) {
        const line = `${info.state}, ends ${info.endAt.toISOString().slice(11, 19)}`
        if (line !== last) say(`E2B: ${line}`)
        last = line
        if (info.state === "running") lastRunning = Date.now()
        else pausedAt ??= Date.now()
      }
      await sleep(10_000)
    }
  })()
  return {
    pausedAt: () => pausedAt,
    lastRunning: () => lastRunning,
    stop: async () => {
      stopped = true
      await done
    }
  }
}

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`

const scenarios: Record<string, (apiUrl: string) => Promise<boolean>> = {
  command: async (apiUrl) => {
    const { sandbox, daemonToken, origin, traffic } = await setup(apiUrl, { published: false })
    const started = Date.now()
    const watcher = watch(sandbox.sandboxId)
    try {
      // Delivered through the port URL, as the ProjectDO delivers a wake that comes due.
      const deliver = fileURLToPath(new URL("../../dreamd/scripts/deliver.ts", import.meta.url))
      const command = "date -u +%FT%TZ > /tmp/run-started; sleep 420; date -u +%FT%TZ > /tmp/run-done"
      say(
        execFileSync("node", [deliver, origin(DefaultDaemonPort), daemonToken, "wake", "check", command], {
          env: { ...process.env, E2B_TRAFFIC_TOKEN: traffic },
          encoding: "utf8"
        }).trim()
      )
      while (Date.now() - started < 14 * 60_000 && watcher.pausedAt() === undefined) await sleep(5_000)
      await watcher.stop()
      const pausedAt = watcher.pausedAt()
      say(`paused ${pausedAt === undefined ? "never (in 14 min)" : `${minutes(pausedAt - started)} after the wake`}`)
      // Reading the files resumes it, which is fine now.
      const files = await run(
        sandbox,
        "cat /tmp/run-started /tmp/run-done 2>&1; grep -h 'Scheduled command\\|awake' ~/.dream/logs/dreamd.log | cut -c1-200"
      )
      say(`in the sandbox:\n${files}`)
      const [begun, ended] = files.split("\n")
      const took = begun && ended ? Date.parse(ended) - Date.parse(begun) : Number.NaN
      say(`the command took ${minutes(took)} of real time`)
      return Number.isFinite(took) && took < 8 * 60_000 && pausedAt !== undefined && pausedAt - started > 7 * 60_000
    } finally {
      await sandbox.kill()
      say("killed")
    }
  },

  websocket: async (apiUrl) => {
    const { sandbox, origin, traffic } = await setup(apiUrl, { published: true })
    const started = Date.now()
    const watcher = watch(sandbox.sandboxId)
    try {
      const url = `${origin(appPort).replace("https://", "wss://")}/ws`
      const ws = new WebSocket(url, { headers: { "e2b-traffic-access-token": traffic } } as never)
      let closed: string | undefined
      let echoes = 0
      ws.addEventListener("close", (event) => {
        closed = `${event.code} after ${minutes(Date.now() - started)}`
        say(`WebSocket closed: ${closed}`)
      })
      ws.addEventListener("message", () => echoes++)
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve)
        ws.addEventListener("error", reject)
      })
      say("WebSocket open")
      let sent = 0
      while (Date.now() - started < 8 * 60_000 && closed === undefined) {
        ws.send(`ping ${sent++}`)
        await sleep(20_000)
      }
      await sleep(2_000)
      say(
        `after ${minutes(Date.now() - started)}: sent ${sent}, echoed ${echoes}, ${closed === undefined ? "still open" : `closed ${closed}`}`
      )
      say(`TCP table for :${appPort}:\n${await run(sandbox, "grep -i ':0BB8 ' /proc/net/tcp /proc/net/tcp6")}`)
      const ok = closed === undefined && echoes === sent && watcher.pausedAt() === undefined
      ws.close()
      await watcher.stop()
      return ok
    } finally {
      await sandbox.kill()
      say("killed")
    }
  },

  requests: async (apiUrl) => {
    const { sandbox, origin, traffic } = await setup(apiUrl, { published: true })
    const started = Date.now()
    const watcher = watch(sandbox.sandboxId)
    try {
      const headers = { "e2b-traffic-access-token": traffic }
      const statuses: Array<number> = []
      while (Date.now() - started < 7 * 60_000) {
        statuses.push((await fetch(origin(appPort), { headers })).status)
        await sleep(40_000)
      }
      const lastRequest = Date.now()
      say(
        `${statuses.length} requests: ${[...new Set(statuses)].join(", ")}; paused meanwhile: ${watcher.pausedAt() !== undefined}`
      )
      const closedPort = await fetch(origin(3001), { headers })
      say(
        `a port nothing listens on: ${closedPort.status} ${closedPort.headers.get("content-type")} ${(await closedPort.text()).slice(0, 200)}`
      )
      const awakeDuringUse = watcher.pausedAt() === undefined
      while (Date.now() - lastRequest < 9 * 60_000 && watcher.pausedAt() === undefined) await sleep(5_000)
      await watcher.stop()
      const pausedAt = watcher.pausedAt()
      say(`paused ${pausedAt === undefined ? "never" : `${minutes(pausedAt - lastRequest)} after the last request`}`)
      return awakeDuringUse && statuses.every((s) => s === 200) && pausedAt !== undefined
    } finally {
      await sandbox.kill()
      say("killed")
    }
  }
}

scenarios.loopback = async (apiUrl) => {
  const { sandbox } = await setup(apiUrl, { published: true })
  const started = Date.now()
  const watcher = watch(sandbox.sandboxId)
  try {
    await run(
      sandbox,
      "setsid nohup bash -c 'while true; do curl -s -H connection:close localhost:3000 > /dev/null; sleep 15; done' > /dev/null 2>&1 < /dev/null &"
    )
    while (Date.now() - started < 9 * 60_000 && watcher.pausedAt() === undefined) await sleep(5_000)
    await watcher.stop()
    const pausedAt = watcher.pausedAt()
    say(`paused ${pausedAt === undefined ? "never (in 9 min)" : `${minutes(pausedAt - started)} after it was set up`}`)
    return pausedAt !== undefined && pausedAt - started < 6.5 * 60_000
  } finally {
    await sandbox.kill()
    say("killed")
  }
}

const [mode, arg] = process.argv.slice(2)
if (mode === "api") api(Number(arg ?? 8790))
else if (mode !== undefined && arg !== undefined && scenarios[mode] !== undefined) {
  const ok = await scenarios[mode](arg)
  say(ok ? "PASS" : "FAIL")
  process.exit(ok ? 0 : 1)
} else {
  console.error("usage: stay-awake-check.ts api [port] | command|websocket|requests|loopback <api url>")
  process.exit(2)
}
