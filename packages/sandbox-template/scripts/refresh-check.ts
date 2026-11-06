/**
 * Checks a sandbox refresh end to end on real E2B, with fakes for the Worker and Claude
 * (packages/dreamd/scripts/fake-api.ts and fake-anthropic.ts, run inside the sandbox), so no account is needed:
 *
 *   DREAM_TEMPLATE=<old> node scripts/refresh-check.ts setup     a project sandbox from the template's current build:
 *                                                                files, dreamd on Claude Code (HARNESS=codex for
 *                                                                Codex, against fake-responses.ts), the fakes
 *   node scripts/refresh-check.ts turn "<message>"               deliver a message and wait for the turn to end
 *   node scripts/refresh-check.ts inspect                        versions, release, files, servers, processes
 *   node scripts/refresh-check.ts exec "<command>"               run a command in it
 *   node scripts/refresh-check.ts kill
 *
 * Between `setup` and the refresh, build a newer template under the same name, then refresh it the way the
 * ProjectDO does: `node apps/api/scripts/refresh-sandbox.ts <sandbox> <daemon token> <template>` (`setup` prints
 * the command). The sandbox's ids are kept in /tmp/dream-refresh-check.json (or STATE); its tokens are throwaway
 * test values.
 *
 * Messages for the fake Claude: `REMEMBER: <word>` is recalled by later turns (so a resumed session shows),
 * `RUN: <command>` and `RUN_BG: <command>` make it run a command with the Bash tool (in the background for RUN_BG).
 */
import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DaemonEnvFile, DefaultDaemonPort, devSandboxMetadata } from "@dream/domain"
import { Sandbox } from "e2b"
import { templateName } from "../src/index.ts"

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}
const stateFile = process.env.STATE ?? "/tmp/dream-refresh-check.json"
const fakeAnthropic = fileURLToPath(new URL("../../dreamd/scripts/fake-anthropic.ts", import.meta.url))

type State = { readonly sandboxId: string; readonly daemonToken: string; readonly template: string }
const load = (): State => JSON.parse(readFileSync(stateFile, "utf8")) as State

const run = async (sandbox: Sandbox, command: string, timeoutMs = 120_000) => {
  const result = await sandbox.commands
    .run(command, { timeoutMs })
    .catch((error: { result?: { stdout: string; stderr: string; exitCode: number } }) => {
      if (error.result === undefined) throw error
      return error.result
    })
  return `${result.stdout}${result.stderr}`.trim()
}

/** A long-running process in its own session, so nothing the test restarts takes it down. */
const daemonize = (command: string, log: string) => `setsid nohup ${command} > ${log} 2>&1 < /dev/null &`

const project = {
  "/home/user/project/server.js": `const http = require("node:http")
const port = Number(process.argv[2] ?? 3000)
http.createServer((_, res) => res.end("strength log v1 on " + port + "\\n")).listen(port)
`,
  "/home/user/project/data/sets.csv": "date,lift,kg\n2026-11-01,squat,100\n2026-11-03,squat,102.5\n"
}

const harness = process.env.HARNESS === "codex" ? "codex" : "claude-code"

const setup = async () => {
  const sandbox = await Sandbox.create(templateName, {
    ...connection,
    timeoutMs: 60 * 60_000,
    metadata: devSandboxMetadata("refresh-check")
  })
  const daemonToken = randomBytes(20).toString("hex")
  writeFileSync(stateFile, JSON.stringify({ sandboxId: sandbox.sandboxId, daemonToken, template: templateName }))
  console.log(`sandbox ${sandbox.sandboxId} from ${templateName}, ${harness}`)
  for (const [path, content] of Object.entries(project)) await sandbox.files.write(path, content)
  await sandbox.files.write("/home/user/fakes/fake-anthropic.ts", readFileSync(fakeAnthropic, "utf8"))
  await sandbox.files.write(
    "/home/user/.claude/settings.json",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18789" } }, null, 2)
  )
  console.log(
    await run(
      sandbox,
      [
        daemonize("node /home/user/fakes/fake-anthropic.ts 18789", "/home/user/fakes/anthropic.log"),
        // The fake API needs dreamd's dependencies; a copy outlives the refresh swapping /opt/dream.
        "cp -r /opt/dream /home/user/fakes/dream",
        daemonize("node /home/user/fakes/dream/packages/dreamd/scripts/fake-api.ts 8787", "/home/user/fakes/api.log"),
        daemonize(
          "node /home/user/fakes/dream/packages/dreamd/scripts/fake-responses.ts 18788",
          "/home/user/fakes/responses.log"
        ),
        "sleep 2 && tail -n 1 /home/user/fakes/anthropic.log /home/user/fakes/api.log"
      ].join("\n")
    )
  )
  await sandbox.files.write(
    DaemonEnvFile,
    [
      "DREAM_API_URL=http://127.0.0.1:8787",
      "DREAM_PROJECT_ID=prj_dev",
      "DREAM_PROJECT_TOKEN=dev-project-token",
      `DREAM_DAEMON_TOKEN=${daemonToken}`,
      `DREAM_HARNESS=${harness}`,
      ...(harness === "codex" ? ["DREAM_CODEX_BASE_URL=http://127.0.0.1:18788/backend-api/codex"] : []),
      ""
    ].join("\n")
  )
  console.log(
    await run(
      sandbox,
      'for i in $(seq 1 30); do grep -q "dreamd started" ~/.dream/logs/dreamd.log && break; sleep 1; done; grep -A3 "dreamd started" ~/.dream/logs/dreamd.log | tail -4'
    )
  )
  console.log(
    `refresh it with: node apps/api/scripts/refresh-sandbox.ts ${sandbox.sandboxId} <daemon token in ${stateFile}> <template>`
  )
}

const connect = async () => Sandbox.connect(load().sandboxId, { ...connection, timeoutMs: 60 * 60_000 })

const deliver = (token: string, args: string) =>
  `node --disable-warning=ExperimentalWarning /opt/dream/packages/dreamd/scripts/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ${token} ${args}`

const turn = async (message: string) => {
  const sandbox = await connect()
  const { daemonToken } = load()
  const quoted = `'${message.replaceAll("'", "'\\''")}'`
  const fake = (await run(sandbox, "grep -o 'DREAM_HARNESS=.*' ~/.dream/dreamd.env")).includes("codex")
    ? "/home/user/fakes/responses.log"
    : "/home/user/fakes/anthropic.log"
  const before = Number(await run(sandbox, `wc -l < ${fake}`))
  console.log(await run(sandbox, deliver(daemonToken, `message ${quoted}`)))
  const started = Date.now()
  // Wait for the turn to start and end.
  let seen = false
  while (Date.now() - started < 5 * 60_000) {
    const health = await run(sandbox, deliver(daemonToken, "health"))
    if (health.includes('"running"')) seen = true
    else if (seen || Date.now() - started > 30_000) break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  console.log(`--- turn took ~${Math.round((Date.now() - started) / 1000)} s; the fake model saw:`)
  console.log(await run(sandbox, `tail -n +${before + 1} ${fake}`))
  console.log("--- dreamd log")
  console.log(await run(sandbox, "tail -8 ~/.dream/logs/dreamd.log | cut -c1-300"))
}

const inspect = async () => {
  const sandbox = await connect()
  const { daemonToken } = load()
  const checks: ReadonlyArray<readonly [string, string]> = [
    ["release", "cat /opt/dream/release.json 2>/dev/null || echo '(no release.json: an older build)'"],
    ["health", deliver(daemonToken, "health")],
    [
      "CLIs",
      "cd ~/.ai-sdk-harness/.harness-bootstrap && claude-code/node_modules/.bin/claude --version && codex/node_modules/.bin/codex --version && node -p \"'agent sdk ' + require('./claude-code/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version\" && ls -a claude-code codex | grep bootstrap-"
    ],
    ["dream", "dream --help 2>&1 | head -2"],
    ["project files", "cd /home/user/project && find . -type f | sort | xargs sha256sum"],
    ["servers", 'for p in 3000 3001 3002; do echo "$p: $(curl -s --max-time 2 localhost:$p || echo DOWN)"; done'],
    ["state", "ls ~/.dream ~/.dream/state; ls ~/.claude/projects 2>/dev/null; ls ~/.ai-sdk-harness"],
    [
      "processes",
      "ps -eo pid,pgid,sid,etimes,args --sort=pid | grep -E 'supervisor|dreamd|bridge|claude|codex|server.js|fake' | grep -v grep | cut -c1-200"
    ],
    ["disk", "df -h / | tail -1; du -sh /opt/dream* ~/.ai-sdk-harness/.harness-bootstrap* 2>/dev/null"]
  ]
  for (const [name, command] of checks) console.log(`--- ${name}\n${await run(sandbox, command)}`)
}

const [command, arg] = process.argv.slice(2)
if (command === "setup") await setup()
else if (command === "turn" && arg !== undefined) await turn(arg)
else if (command === "inspect") await inspect()
else if (command === "exec" && arg !== undefined) console.log(await run(await connect(), arg, 600_000))
else if (command === "kill") await (await connect()).kill()
else console.error("usage: refresh-check.ts setup | turn <message> | inspect | exec <command> | kill")
