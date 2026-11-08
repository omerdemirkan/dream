/**
 * Checks the project's log end to end on real E2B, with fakes for the Worker and Claude
 * (packages/dreamd/scripts/fake-api.ts and fake-anthropic.ts, run inside the sandbox), so no account is needed:
 *
 *   DREAM_TEMPLATE=<template> [FROM=<template>:<tag>] node scripts/logs-check.ts
 *
 * In a throwaway sandbox of the template it starts dreamd on Claude Code against the fakes, has the agent start a
 * server that writes to ~/logs and publish it, and a second server that writes to a file of its own; then runs a
 * scheduled command that fails, and sends requests the app answers with 500 through the fake API's stand-in for the
 * gateway (`/gw/…`), which tells the agent once, as the ProjectDO would. It checks that the agent's turns got the
 * failure and the alert, and that `dream logs` shows the gateway's requests, the servers' output, the failed run's
 * output and dreamd's own events; then that all of it is still there after the sandbox sleeps and wakes, and, with
 * `FROM` (an older build of the template, e.g. `dream-sandbox-x:release-…`, to start the sandbox from), after a
 * refresh to the template's current build. The fake API stands in for
 * the gateway and its rule (three server errors outside a turn); the ProjectDO's real rules are checked in
 * apps/api/test/projectLog.test.ts. KEEP=1 leaves the sandbox up. Prints no token: the sandbox has only test values.
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DaemonEnvFile, DefaultDaemonPort, devSandboxMetadata } from "@dream/domain"
import { Sandbox } from "e2b"
import { templateName } from "../src/index.ts"

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}
const from = process.env.FROM ?? templateName
const fakeAnthropic = fileURLToPath(new URL("../../dreamd/scripts/fake-anthropic.ts", import.meta.url))
const refreshSandbox = fileURLToPath(new URL("../../../apps/api/scripts/refresh-sandbox.ts", import.meta.url))

/** Never print anything that looks like a credential, whatever the sandbox says. */
const clean = (text: string) =>
  text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…").replace(/(token[=:" ]+)[^\s"]{12,}/gi, "$1…")

const run = async (sandbox: Sandbox, command: string, timeoutMs = 120_000) => {
  const result = await sandbox.commands
    .run(command, { timeoutMs })
    .catch((error: { result?: { stdout: string; stderr: string; exitCode: number } }) => {
      if (error.result === undefined) throw error
      return error.result
    })
  return clean(`${result.stdout}${result.stderr}`.trim())
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const daemonize = (command: string, log: string) => `setsid nohup ${command} >> ${log} 2>&1 < /dev/null &`

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === "" ? "" : `\n${detail}`}`)
  if (!ok) failures++
}

const project = {
  // Answers /api/* with 500 and says why on stderr, as an app with a broken database would.
  "/home/user/project/server.js": `const http = require("node:http")
http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    console.error("Error: SQLITE_BUSY: database is locked (" + req.url + ")\\n    at query (/home/user/project/db.js:4:11)")
    res.writeHead(500).end("boom")
    return
  }
  console.log("GET " + req.url + " 200")
  res.end("<!doctype html><title>Recipes</title><p>ok")
}).listen(3000, () => console.log("listening on 3000"))
`,
  // Writes to a file of its own choosing, outside ~/logs.
  "/home/user/project/worker.js": `require("node:http").createServer((_, res) => res.end("ok")).listen(3001, () => {
  console.log("worker listening on 3001")
  setInterval(() => console.log("worker: synced 12 recipes"), 5000)
})
`
}

const sandbox = await Sandbox.create(from, {
  ...connection,
  timeoutMs: 60 * 60_000,
  metadata: devSandboxMetadata("logs-check")
})
const daemonToken = randomBytes(20).toString("hex")
console.log(`sandbox ${sandbox.sandboxId} from ${from}`)
const deliver = (args: string) =>
  `node --disable-warning=ExperimentalWarning /opt/dream/packages/dreamd/scripts/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ${daemonToken} ${args}`

/** Waits for the turns that start to end, and returns what the fake model logged since `from` lines. */
const settle = async (from: number) => {
  const started = Date.now()
  let quiet = 0
  while (Date.now() - started < 4 * 60_000 && quiet < 3) {
    const health = await run(sandbox, deliver("health"))
    quiet = health.includes('"running"') || !health.includes('"queued":0') ? 0 : quiet + 1
    await sleep(2000)
  }
  return run(sandbox, `tail -n +${from + 1} /home/user/fakes/anthropic.log`)
}
const modelLines = async () => Number(await run(sandbox, "wc -l < /home/user/fakes/anthropic.log"))
const logs = (args: string) => run(sandbox, `dream logs ${args} 2>&1`)

try {
  for (const [path, content] of Object.entries(project)) await sandbox.files.write(path, content)
  await sandbox.files.write("/home/user/fakes/fake-anthropic.ts", readFileSync(fakeAnthropic, "utf8"))
  await sandbox.files.write(
    "/home/user/.claude/settings.json",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18789" } }, null, 2)
  )
  const fakeEnv = `FAKE_PUBLIC_URL=http://127.0.0.1:8787/gw FAKE_DAEMON_URL=http://127.0.0.1:${DefaultDaemonPort} FAKE_DAEMON_TOKEN=${daemonToken}`
  await run(
    sandbox,
    [
      daemonize("node /home/user/fakes/fake-anthropic.ts 18789", "/home/user/fakes/anthropic.log"),
      // The fake API needs dreamd's dependencies; a copy outlives a refresh swapping /opt/dream.
      "cp -r /opt/dream /home/user/fakes/dream",
      daemonize(
        `env ${fakeEnv} node /home/user/fakes/dream/packages/dreamd/scripts/fake-api.ts 8787`,
        "/home/user/fakes/api.log"
      ),
      "sleep 2"
    ].join("\n")
  )
  await sandbox.files.write(
    DaemonEnvFile,
    [
      "DREAM_API_URL=http://127.0.0.1:8787",
      "DREAM_PROJECT_ID=prj_dev",
      "DREAM_PROJECT_TOKEN=dev-project-token",
      `DREAM_DAEMON_TOKEN=${daemonToken}`,
      "DREAM_HARNESS=claude-code",
      ""
    ].join("\n")
  )
  await run(
    sandbox,
    'for i in $(seq 1 40); do grep -q "dreamd started" ~/.dream/logs/dreamd.log && break; sleep 1; done'
  )

  // The agent starts its servers the way the hosting skill says, and publishes the app.
  let mark = await modelLines()
  await run(
    sandbox,
    deliver(
      `message 'RUN: cd ~/project && (setsid nohup node server.js >> ~/logs/web.log 2>&1 < /dev/null &) && (setsid nohup node worker.js > ~/project/worker.out 2>&1 < /dev/null &) && sleep 1 && dream publish --port 3000'`
    )
  )
  await settle(mark)

  // A scheduled command that fails wakes the agent with its output.
  mark = await modelLines()
  await run(sandbox, deliver(`wake 'check the feed' 'curl -fsS --max-time 5 localhost:3000/api/feed'`))
  const failedTurn = await settle(mark)
  check("a failing --run command wakes the agent", failedTurn.includes("exited with code 22"), failedTurn)

  // People using the app hit server errors between turns: Dream tells the agent once.
  await sleep(35_000) // the worker's output file is found within half a minute
  mark = await modelLines()
  await run(sandbox, "for i in 1 2 3 4; do curl -s -o /dev/null localhost:8787/gw/api/recipes?page=$i; done")
  const alertTurn = await settle(mark)
  check(
    "server errors between turns wake the agent with Dream's alert",
    alertTurn.includes("Dream noticed a problem"),
    alertTurn
  )
  check("the alert names the failing requests", alertTurn.includes("GET /api/recipes?page=3 → 500"), alertTurn)

  const verify = async (when: string) => {
    const all = await logs("--limit 400")
    const errors = await logs("--errors --limit 400")
    check(`${when}: the gateway's requests`, /gateway {2}ERROR GET \/api\/recipes\?page=1 → 500/.test(all), all)
    check(
      `${when}: the published app's own error, with its stack`,
      /app web {2}ERROR Error: SQLITE_BUSY/.test(errors) && errors.includes("at query (/home/user/project/db.js:4:11)"),
      errors
    )
    check(
      `${when}: the second server's output, found by its port`,
      /app worker {2}worker listening on 3001/.test(all),
      all
    )
    check(
      `${when}: the failed run with its output`,
      /run wak_\S+ {2}ERROR `curl -fsS --max-time 5 localhost:3000\/api\/feed` failed with exit code 22/.test(errors) &&
        errors.includes("curl: (22)"),
      errors
    )
    check(`${when}: dreamd's start`, /dream {2}dreamd \S+ started/.test(all), all)
    check(`${when}: the turns`, all.includes("A turn started, woken by a wake-up"), all)
    check(`${when}: the check after the turn`, all.includes("After the turn, Dream loaded the published URL"), all)
    check(`${when}: machine readings`, (await logs("--source machine --limit 3")).includes("memory "), "")
    return all
  }
  await verify("before sleeping")
  console.log(`--- dream logs --errors\n${await logs("--errors --limit 30")}`)

  // Asleep and awake again: everything is still there, and dreamd says it slept.
  await sandbox.pause()
  console.log("paused; resuming in 60 s")
  await sleep(60_000)
  await Sandbox.connect(sandbox.sandboxId, { ...connection, timeoutMs: 60 * 60_000 })
  await sleep(15_000)
  const awake = await verify("after a sleep")
  check("dreamd noticed the sleep", /The sandbox slept for about \d+ (s|min)/.test(awake), awake)

  if (from !== templateName) {
    const out = clean(
      execFileSync("node", [refreshSandbox, sandbox.sandboxId, daemonToken, templateName], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_USE_ENV_PROXY: "1" }
      })
    )
    const said = out.split("\n").filter((line) => /Refreshed|Current/.test(line))
    console.log(`refreshed to ${templateName}: ${said.join(" ").slice(0, 300)}`)
    await sleep(10_000)
    const refreshed = await verify("after a refresh")
    check("dreamd's start after the refresh says so", /Dream refreshed it from release/.test(refreshed), refreshed)
  }
  console.log(`--- dream logs --source dream\n${await logs("--source dream --limit 40")}`)
} finally {
  if (process.env.KEEP === "1") console.log(`kept ${sandbox.sandboxId}`)
  else await sandbox.kill()
}
console.log(failures === 0 ? "all checks passed" : `${failures} checks failed`)
process.exitCode = failures === 0 ? 0 : 1
