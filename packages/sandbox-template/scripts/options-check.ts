/**
 * Checks `dream ask --show` in a sandbox of a template build, against the fake Worker
 * (packages/dreamd/scripts/fake-api.ts, as shipped in the build): option previews made of a phone screenshot, a
 * desktop page, a recording and sounds, uploaded through dreamd with the sizes and lengths `dream` measured, and
 * audio refused outside a preview. Uses no model and no one's subscription.
 *
 *   node packages/sandbox-template/scripts/options-check.ts [template[:tag]]   (default: the current dream-sandbox)
 */
import { DaemonEnvFile, devSandboxMetadata } from "@dream/domain"
import { Sandbox } from "e2b"
import { templateName } from "../src/index.ts"

const scripts = "/opt/dream/packages/dreamd/scripts"
const log = "/home/user/.dream/logs/dreamd.log"

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}

type Run = { stdout: string; stderr: string; exitCode: number }

const sh = async (sandbox: Sandbox, command: string, timeoutMs = 120_000) => {
  const result: Run = await sandbox.commands
    .run(command, { timeoutMs, cwd: "/home/user" })
    .catch((error: { result?: Run }) => {
      if (error.result !== undefined) return error.result
      throw error
    })
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`.trim() }
}

/** The media `dream ask --show` uploads: two screens for A, a recording for B, two sounds for C. */
const makeMedia = [
  "mkdir -p shots",
  "ffmpeg -loglevel error -y -f lavfi -i color=c=0x2F4A3A:s=780x1688 -frames:v 1 shots/a-1-opening-the-site.png",
  "ffmpeg -loglevel error -y -f lavfi -i color=c=0xF3EEE3:s=1440x900 -frames:v 1 shots/a-2-on-a-laptop.jpg",
  "ffmpeg -loglevel error -y -f lavfi -i testsrc=s=780x1688:d=3 -pix_fmt yuv420p -c:v libx264 shots/b-asking.mp4",
  "ffmpeg -loglevel error -y -f lavfi -i sine=f=880:d=1.6 -c:a aac shots/c-chime.m4a",
  "ffmpeg -loglevel error -y -f lavfi -i sine=f=440:d=2 shots/c-tone.wav"
].join(" && ")

const ask = [
  "dream ask 'How should a weekend get booked?' --json",
  "--option 'Calendar first' --option 'Requests first' --option 'Rotation'",
  "--show 'Calendar first=shots/a-*'",
  "--show 'Requests first=shots/b-asking.mp4'",
  "--show 'Rotation=shots/c-chime.m4a,shots/c-tone.wav'"
].join(" ")

interface Media {
  readonly kind: string
  readonly contentType: string
  readonly width?: number
  readonly height?: number
  readonly durationSeconds?: number
  readonly caption?: string
}

const check = async (sandbox: Sandbox): Promise<ReadonlyArray<string>> => {
  await sh(
    sandbox,
    `mkdir -p /tmp/fakes\nsetsid nohup node ${scripts}/fake-api.ts 8787 > /tmp/fakes/api.log 2>&1 < /dev/null &\nsleep 3`
  )
  await sandbox.files.write(
    DaemonEnvFile,
    [
      "DREAM_API_URL=http://127.0.0.1:8787",
      "DREAM_PROJECT_ID=prj_dev",
      "DREAM_PROJECT_TOKEN=dev-project-token",
      "DREAM_DAEMON_TOKEN=options-check-daemon-token",
      "DREAM_HARNESS=claude-code",
      ""
    ].join("\n")
  )
  const up = await sh(
    sandbox,
    `for i in $(seq 1 60); do grep -q "dreamd started" ${log} 2>/dev/null && exit 0; sleep 1; done; exit 1`
  )
  if (up.exitCode !== 0) return ["dreamd didn't start"]
  const made = await sh(sandbox, makeMedia)
  if (made.exitCode !== 0) return [`making the media failed: ${made.output}`]

  const problems: Array<string> = []
  const asked = await sh(sandbox, ask)
  if (asked.exitCode !== 0) return [`dream ask --show failed: ${asked.output}`]
  const message = JSON.parse(asked.output.slice(asked.output.indexOf("{"))) as {
    previews?: ReadonlyArray<{ option: string; media: ReadonlyArray<Media> }>
  }
  const previews = message.previews ?? []
  const of = (option: string) => previews.find((p) => p.option === option)?.media ?? []
  const expect = (what: string, ok: boolean, got: unknown) => {
    if (!ok) problems.push(`${what}: got ${JSON.stringify(got)}`)
  }
  const [phone, desktop] = of("Calendar first")
  expect(
    "A's phone screen",
    phone?.width === 780 && phone.height === 1688 && phone.caption === "Opening the site",
    phone
  )
  expect(
    "A's desktop page",
    desktop?.contentType === "image/jpeg" && desktop.width === 1440 && desktop.height === 900,
    desktop
  )
  const [recording] = of("Requests first")
  expect(
    "B's recording",
    recording?.kind === "video" &&
      recording.width === 780 &&
      recording.height === 1688 &&
      recording.durationSeconds === 3,
    recording
  )
  const [chime, tone] = of("Rotation")
  expect(
    "C's m4a",
    chime?.kind === "audio" && chime.contentType === "audio/mp4" && Math.abs((chime.durationSeconds ?? 0) - 1.6) < 0.15,
    chime
  )
  expect("C's wav", tone?.kind === "audio" && tone.contentType === "audio/wav" && tone.durationSeconds === 2, tone)

  const refused = await sh(sandbox, "dream message 'Listen' --media shots/c-chime.m4a")
  expect(
    "audio in a message",
    refused.exitCode !== 0 && refused.output.includes("only as an option's preview"),
    refused.output
  )
  const stray = await sh(sandbox, "dream ask 'Which?' --option A --show 'B=shots/c-tone.wav'")
  expect(
    "a preview for no option",
    stray.exitCode !== 0 && stray.output.includes("isn't one of the options"),
    stray.output
  )

  console.log(
    asked.output
      .split("\n")
      .filter((line) => line.startsWith("Asked"))
      .join("\n") || "(asked)"
  )
  for (const p of previews)
    console.log(
      `  ${p.option}: ${p.media.map((m) => `${m.contentType} ${m.width ?? "-"}x${m.height ?? "-"} ${m.durationSeconds ?? ""}s "${m.caption ?? ""}"`).join(", ")}`
    )
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sandbox = await Sandbox.create(process.argv[2] ?? templateName, {
    ...connection,
    timeoutMs: 10 * 60_000,
    metadata: devSandboxMetadata("options-check")
  })
  try {
    const problems = await check(sandbox)
    console.log(problems.length === 0 ? "options: ok" : `options: FAILED\n${problems.map((p) => `  ${p}`).join("\n")}`)
    if (problems.length > 0) process.exitCode = 1
  } finally {
    await sandbox.kill().catch(() => undefined)
  }
}
