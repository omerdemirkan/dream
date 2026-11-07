/**
 * Times what the person waits on while the agent builds, in a sandbox of a template, so a smaller machine can be
 * compared with today's (see docs/proposals/sandbox-hosting.html):
 *
 *   node scripts/size-check.ts <template> [rounds]
 *
 * In a fresh sandbox (killed at the end): a Vite + React app created and installed with pnpm, then built; a Next.js
 * app installed and built; Playwright's Chromium taking screenshots of the built app, one at a time and four at once;
 * and the same Next.js build again with a dev server, a browser and the agent's harness CLI loaded beside it. Each step
 * prints its wall time and the most memory the sandbox had in use (sampled every half second).
 */
import { devSandboxMetadata } from "@dream/domain"
import { Sandbox } from "e2b"

const [template, roundsArg] = process.argv.slice(2)
if (template === undefined) {
  console.error("usage: node scripts/size-check.ts <template> [rounds]")
  process.exit(1)
}
const rounds = Number(roundsArg ?? 1)
const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}

const sampler = [
  "rm -f /tmp/mem.log",
  `printf 'while true; do free -m | awk "/Mem:/ {print \\$3}" >> /tmp/mem.log; sleep 0.5; done\\n' > /tmp/sample.sh`,
  "setsid nohup bash /tmp/sample.sh > /dev/null 2>&1 < /dev/null & echo $! > /tmp/sample.pid"
].join("; ")

const steps: ReadonlyArray<readonly [string, string]> = [
  [
    "vite: create + pnpm install",
    "cd ~ && rm -rf vite && pnpm create vite@6 vite --template react-ts >/dev/null && cd vite && pnpm install --reporter=silent --dangerously-allow-all-builds"
  ],
  ["vite: build", "cd ~/vite && pnpm exec vite build >/dev/null"],
  [
    "next: create + pnpm install",
    "cd ~ && rm -rf next && pnpm dlx create-next-app@15 next --ts --app --eslint --no-tailwind --no-src-dir --import-alias '@/*' --use-pnpm --yes --disable-git >/dev/null 2>&1"
  ],
  ["next: build", "cd ~/next && pnpm exec next build >/dev/null"],
  [
    "playwright: 3 screenshots, one at a time",
    "cd ~/vite && (setsid nohup pnpm exec vite preview --port 4173 >/dev/null 2>&1 &) && sleep 2 && for i in 1 2 3; do npx playwright screenshot --wait-for-timeout 500 http://localhost:4173 /tmp/s$i.png >/dev/null; done"
  ],
  [
    "playwright: 4 screenshots at once",
    "cd ~ && for i in 1 2 3 4; do npx playwright screenshot --wait-for-timeout 1500 http://localhost:4173 /tmp/p$i.png >/dev/null & done; wait"
  ],
  [
    "next: build again, beside a dev server, a browser and Claude Code",
    "cd ~/next && (setsid nohup pnpm exec next dev -p 3001 >/dev/null 2>&1 &) && sleep 4 && curl -s localhost:3001 >/dev/null; (npx playwright screenshot --wait-for-timeout 8000 http://localhost:3001 /tmp/d.png >/dev/null &); (claude --version >/dev/null 2>&1 &); rm -rf .next && pnpm exec next build >/dev/null"
  ]
]

/** envd connections through the dev proxy sometimes drop; a quick command is worth one more try. */
const retried = async <A>(attempt: () => Promise<A>): Promise<A> => {
  try {
    return await attempt()
  } catch (error) {
    if (!String(error).includes("fetch failed")) throw error
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    return attempt()
  }
}

const main = async () => {
  const created = Date.now()
  const sandbox = await Sandbox.create(template, {
    ...connection,
    timeoutMs: 40 * 60_000,
    metadata: devSandboxMetadata("size-check")
  })
  try {
    const shape = await sandbox.commands.run("nproc; free -m | awk '/Mem:/ {print $2}'")
    console.log(
      `${template}: ${shape.stdout.trim().split("\n").join(" vCPU, ")} MB, created in ${Date.now() - created} ms`
    )
    for (let round = 1; round <= rounds; round++) {
      for (const [name, command] of steps) {
        await retried(() => sandbox.commands.run(sampler))
        const started = Date.now()
        const result = await sandbox.commands
          .run(command, { timeoutMs: 15 * 60_000 })
          .then(() => "ok")
          .catch((error: { result?: { exitCode: number; stderr: string } }) => {
            const tail = (error.result?.stderr ?? String(error)).trim().split("\n").slice(-2).join(" | ")
            return `failed (${error.result?.exitCode ?? "?"}): ${tail.slice(0, 200)}`
          })
        const seconds = ((Date.now() - started) / 1000).toFixed(1)
        const peak = await retried(() =>
          sandbox.commands.run("kill $(cat /tmp/sample.pid) 2>/dev/null; sort -n /tmp/mem.log | tail -1")
        )
        console.log(`  ${round}. ${name}: ${seconds} s, peak ${peak.stdout.trim()} MB used, ${result}`)
      }
      await sandbox.commands.run("pkill -f 'vite preview'; pkill -f 'next dev'; true").catch(() => undefined)
    }
    const oom = await sandbox.commands
      .run("dmesg 2>/dev/null | grep -ci 'out of memory' || true")
      .catch(() => undefined)
    console.log(`  OOM kills: ${oom?.stdout.trim() || "unknown"}`)
  } finally {
    await sandbox.kill().catch(() => undefined)
    console.log(`  killed ${sandbox.sandboxId}`)
  }
}

main().catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
