/**
 * Checks notifications from apps end to end on real E2B: an app in a sandbox of the template (DREAM_TEMPLATE)
 * notifies the person from a scheduled `--run` job while the agent sleeps, through the real `dream` CLI and dreamd,
 * to a stand-in Worker running the control plane's own code (`apps/api/scripts/notify-standin.ts`, exposed):
 *
 *   node packages/sandbox-template/scripts/notify-check.ts <stand-in url> [payload file]
 *
 * The agent's part (`dream notify setup`) runs as a command in the sandbox; the person's "Allow" goes to the
 * stand-in. The scheduled job is delivered as the ProjectDO delivers a due wake (`dreamd/scripts/deliver.ts`).
 * Writes the APNs payload of the first notification to [payload file] (for `xcrun simctl push`), and kills the
 * sandbox at the end. No model is called: the job exits 0, so the agent is never woken.
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DaemonEnvFile, DefaultDaemonPort } from "@dream/domain"
import { Sandbox } from "e2b"
import { templateName } from "../src/index.ts"

const [standIn, payloadFile] = process.argv.slice(2)
if (standIn === undefined) {
  console.error("usage: notify-check.ts <stand-in url> [payload file]")
  process.exit(2)
}
const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}
const stamp = () => new Date().toISOString().slice(11, 19)
const say = (line: string) => console.log(`${stamp()} ${line}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let ok = true
const expect = (what: string, holds: boolean, detail = "") => {
  say(`${holds ? "✓" : "✗"} ${what}${detail === "" ? "" : `\n    ${detail.replace(/\n/g, "\n    ")}`}`)
  ok &&= holds
}

const check = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${standIn}${path}`, init)
  return (await response.json()) as any
}

/** The app: a page, and the job a scheduled `--run` calls, which notifies them as Fare watch. */
const app = `Bun.serve({
  port: 3000,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/tasks/check-fares") {
      const proc = Bun.spawn(["dream", "notify", "--app", "fare-watch", "--key", "lis",
        "--title", "Lisbon dropped to $412", "--url", "/routes/lis",
        "Round trip May 14–21, down $90 since Monday. TAP, nonstop from SFO."], { stdout: "pipe", stderr: "pipe" })
      const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
      const code = await proc.exited
      await Bun.write("/home/user/project/job.log", (await Bun.file("/home/user/project/job.log").text().catch(() => "")) + code + " " + out)
      return new Response(out, { status: code === 0 ? 200 : 500 })
    }
    return new Response("<h1>Fare watch</h1><p>Lisbon: $412</p>", { headers: { "content-type": "text/html" } })
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
  return { out: `${result.stdout}${result.stderr}`.trim(), code: result.exitCode }
}

const { token } = await check("/check/project")
const sandbox = await Sandbox.create(templateName, {
  ...connection,
  timeoutMs: 10 * 60_000,
  network: { allowPublicTraffic: false },
  metadata: { purpose: "notify-check" }
})
say(`sandbox ${sandbox.sandboxId} from ${templateName}`)
try {
  const daemonToken = randomBytes(20).toString("hex")
  await sandbox.files.write("/home/user/project/app.ts", app)
  await run(sandbox, "cd /home/user/project; setsid nohup bun app.ts > app.log 2>&1 < /dev/null &")
  await sandbox.files.write(
    DaemonEnvFile,
    [
      `DREAM_API_URL=${standIn}`,
      "DREAM_PROJECT_ID=prj_check",
      `DREAM_PROJECT_TOKEN=${token}`,
      `DREAM_DAEMON_TOKEN=${daemonToken}`,
      "DREAM_HARNESS=claude-code",
      ""
    ].join("\n")
  )
  const up = await run(
    sandbox,
    'for i in $(seq 1 30); do grep -q "dreamd started" ~/.dream/logs/dreamd.log && break; sleep 1; done; grep -c "dreamd started" ~/.dream/logs/dreamd.log'
  )
  expect("dreamd started against the stand-in", up.out.trim() !== "0", up.out)

  // The agent sets the app up.
  const setUp = await run(
    sandbox,
    `dream notify setup fare-watch --name "Fare watch" --icon airplane --color blue --why "When a fare you're watching drops below your target" --often "A few times a week at most" --url /`
  )
  expect(
    "dream notify setup asks them first",
    setUp.code === 0 && setUp.out.includes("is waiting for them to allow it"),
    setUp.out
  )
  const early = await run(sandbox, `dream notify --app fare-watch "Too early"`)
  expect(
    "before they allow it, nothing is sent, and that's not a failure",
    early.code === 0 && early.out.includes("haven't allowed"),
    early.out
  )

  // They tap Allow on the phone.
  const allowed = await check("/check/allow", { method: "POST" })
  expect("they allowed it", allowed.state?._tag === "Allowed")

  // The scheduled job, delivered as the ProjectDO delivers a due wake with a command.
  const deliver = fileURLToPath(new URL("../../dreamd/scripts/deliver.ts", import.meta.url))
  const origin = `https://${DefaultDaemonPort}-${sandbox.sandboxId}.${sandbox.sandboxDomain ?? "e2b.app"}`
  const due = () =>
    execFileSync(
      "node",
      [deliver, origin, daemonToken, "wake", "Morning fare check", "curl -fsS http://localhost:3000/tasks/check-fares"],
      { env: { ...process.env, E2B_TRAFFIC_TOKEN: sandbox.trafficAccessToken ?? "" }, encoding: "utf8" }
    ).trim()
  say(due())
  let pushes: Array<{ payload: any }> = []
  for (let i = 0; i < 30 && pushes.length === 0; i++) {
    await sleep(1000)
    pushes = await check("/check/pushes")
  }
  const first = pushes[0]?.payload
  expect(
    "the job's notification reached APNs as Fare watch, with its headline, thread, category and page",
    first?.aps?.alert?.title === "Fare watch" &&
      first?.aps?.alert?.subtitle === "Lisbon dropped to $412" &&
      first?.aps?.category === "app" &&
      first?.aps?.["thread-id"]?.endsWith("/fare-watch") === true &&
      first?.dream?._tag === "OpenApp" &&
      typeof first?.dream?.url === "string" &&
      first.dream.url.endsWith("/routes/lis"),
    JSON.stringify(first)
  )
  const job = await run(sandbox, "cat /home/user/project/job.log")
  expect("the job saw it sent and exited 0", job.out.startsWith("0 Sent to their phone"), job.out)

  // The same job again: a repeat, dropped, still exit 0.
  say(due())
  await sleep(6000)
  pushes = await check("/check/pushes")
  const again = await run(sandbox, "cat /home/user/project/job.log")
  expect(
    "the same notification again is a repeat: no second push, still exit 0",
    pushes.length === 1 && again.out.includes("0 Not sent: the same title and text"),
    again.out
  )

  const log = await run(
    sandbox,
    "grep -h -i 'scheduled command\\|turn' ~/.dream/logs/dreamd.log | cut -c1-200 | tail -n 12"
  )
  expect(
    "the agent stayed asleep: dreamd ran the commands and started no turn",
    !/turn (started|starting)|starting a turn/i.test(log.out),
    log.out
  )
  const events = await check("/check/events")
  expect(
    "the agent's inbox got the allow, and nothing about the job",
    events.includes("AppNotificationsChanged") && !events.includes("WakeDue"),
    JSON.stringify(events)
  )

  const elsewhere = await run(sandbox, `dream notify --app fare-watch --url https://evil.example/ "Book it"`)
  expect("a link off the published URL fails the call (exit 1)", elsewhere.code === 1, elsewhere.out)
  const list = await run(sandbox, "dream notify list")
  expect("dream notify list shows what happened", list.out.includes('fare-watch "Fare watch": allowed'), list.out)
  const history = await check("/check/history")
  expect(
    "the phone's sheet lists it",
    history.notifications?.[0]?.title === "Lisbon dropped to $412",
    JSON.stringify(history.notifications?.map((n: any) => [n.title, n.outcome]))
  )
  if (payloadFile !== undefined && first !== undefined) {
    writeFileSync(payloadFile, JSON.stringify({ "Simulator Target Bundle": "build.omer.dream", ...first }, null, 2))
    say(`wrote the payload to ${payloadFile}`)
  }
} finally {
  await sandbox.kill()
  say("killed the sandbox")
}
say(ok ? "PASS" : "FAIL")
process.exit(ok ? 0 : 1)
