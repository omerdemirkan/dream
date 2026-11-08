/**
 * Checks Dream's Mac probe and Namespace calls against a real Mac (labelled `dream=mac-check`, destroyed at the end):
 *
 *   node apps/api/scripts/mac-check.ts            (NAMESPACE_TOKEN, or a proxy that adds Namespace's bearer token)
 *
 * It rents one Mac the way the ProjectDO does (`Namespace.start`), then probes it (`brokers/MacProbe.ts`, through
 * Namespace's command service) in each state that matters: idle; with an ssh session open, and after it closed; with
 * a detached `sleep`; through a detached build script (xcodebuild of a Swift package, three times, with pauses
 * between), probing every few seconds; and with a booted, idle simulator. Then it extends the deadline and destroys
 * the Mac, checking what Namespace answers. Namespace's free trial runs one Mac at a time, shared with project agents:
 * check that none is running first. The raw probe output of each phase goes to /tmp/mac-check/.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DateTime, Effect, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { macProbeCommand, type MacProbe, parseMacProbe } from "../src/brokers/MacProbe.ts"
import { Namespace } from "../src/brokers/Namespace.ts"
import { ApiConfig } from "../src/Config.ts"

const out = "/tmp/mac-check"
mkdirSync(out, { recursive: true })

const config = ApiConfig.layerTest({
  namespaceToken: Option.some(Redacted.make(process.env.NAMESPACE_TOKEN ?? "placeholder-added-by-proxy")),
  namespaceApiUrl: "https://us.compute.namespaceapis.com"
})

const results: Array<{ check: string; ok: boolean }> = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok })
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`)
}
const show = (probe: MacProbe) =>
  `busy=${probe.busy} ssh=${probe.sshSessions} tools=[${probe.tools.join(",")}] agent=${probe.agentProcesses}@${probe.agentCpu}% lingering=${probe.lingering} cpu=${probe.totalCpu}% sims=${probe.simulators}`

const program = Effect.gen(function* () {
  const namespace = yield* Namespace
  const running = (yield* namespace.list).filter((mac) => mac.status !== "DESTROYED")
  if (running.length > 0) {
    return yield* Effect.die(`a Mac is running already (${running.map((m) => m.instanceId).join(", ")}); try later`)
  }
  const asked = yield* DateTime.now
  const mac = yield* namespace.start({ dream: "mac-check" }, DateTime.add(asked, { minutes: 40 }))
  const id = mac.instanceId
  console.log(`started ${id} in ${DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(asked)} ms`)
  check(
    "start answers Namespace's deadline and creation time",
    mac.deadline !== undefined && mac.createdAt !== undefined
  )

  return yield* Effect.gen(function* () {
    const access = yield* namespace.ssh(id)
    const dir = mkdtempSync(join(tmpdir(), "mac-check-"))
    writeFileSync(join(dir, "key"), `${access.privateKey.trimEnd()}\n`, { mode: 0o600 })
    const sshArgs = [
      ...["-i", join(dir, "key"), "-o", "IdentitiesOnly=yes", "-o", "LogLevel=ERROR", "-o", "BatchMode=yes"],
      ...["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-p", String(access.port)],
      `${access.user}@${access.host}`
    ]
    /** Runs a command over ssh, as `dream mac ssh` does; `background` leaves it running and returns the client. */
    const ssh = (command: string) =>
      Effect.callback<string>((resume) => {
        const child = spawn("ssh", [...sshArgs, "--", command], { stdio: ["ignore", "pipe", "pipe"] })
        let text = ""
        child.stdout.on("data", (chunk) => (text += chunk))
        child.stderr.on("data", (chunk) => (text += chunk))
        child.on("close", () => resume(Effect.succeed(text.trim())))
      })
    const sshOpen = (command: string) => spawn("ssh", [...sshArgs, "--", command], { stdio: "ignore" })
    const probe = (phase: string) =>
      Effect.gen(function* () {
        const ran = yield* namespace.run(id, macProbeCommand)
        writeFileSync(join(out, `${phase}.txt`), ran.stdout)
        const parsed = parseMacProbe(ran.stdout)
        console.log(`     ${phase}: ${show(parsed)}${ran.exitCode === 0 ? "" : ` exit=${ran.exitCode} ${ran.stderr}`}`)
        return parsed
      })
    const wait = (seconds: number) => Effect.sleep(`${seconds} seconds`)

    console.log(`     ${yield* ssh("sw_vers -productVersion; xcodebuild -version | head -1; id -un")}`)
    const idle = yield* probe("idle")
    check("a fresh Mac is idle", !idle.busy && idle.agentProcesses === 0)

    const session = sshOpen("sleep 45")
    yield* wait(6)
    const open = yield* probe("ssh-open")
    check("an open ssh session counts", open.busy && open.sshSessions >= 1)
    session.kill("SIGTERM")
    yield* wait(6)
    const closed = yield* probe("ssh-closed")
    check("a closed session doesn't", closed.sshSessions === 0)
    yield* ssh("pkill -x sleep; true")

    // macOS's nohup refuses to run here ("can't detach from console"); a plain `&` with its output redirected works.
    yield* ssh("sleep 900 > /dev/null 2>&1 < /dev/null &")
    yield* wait(3)
    const sleeping = yield* probe("detached-sleep")
    check("a detached sleep keeps it from stopping (lingering)", sleeping.lingering && sleeping.sshSessions === 0)
    yield* ssh("pkill -x sleep; true")

    // A build script left running: three builds with pauses between, as an agent's loop would have.
    yield* ssh(
      [
        "rm -rf ~/pk && mkdir -p ~/pk && cd ~/pk && swift package init --type executable --name Pk >/dev/null 2>&1",
        "sh -c 'for i in 1 2 3; do xcodebuild -scheme Pk -destination platform=macOS -derivedDataPath ~/dd clean build; sleep 20; done; echo done' > ~/build.log 2>&1 < /dev/null &"
      ].join(" && ")
    )
    let probes = 0
    let busy = 0
    let notBusy = 0
    let notHeld = 0
    for (let i = 0; i < 120; i++) {
      yield* wait(4)
      const p = yield* probe(`build-${String(i).padStart(3, "0")}`)
      const finished =
        (yield* namespace.run(id, ["/bin/sh", "-c", "/usr/bin/tail -1 ~/build.log"])).stdout.trim() === "done"
      if (finished) break
      probes++
      if (p.busy) busy++
      if (!p.busy) notBusy++
      if (!p.busy && !p.lingering) notHeld++
    }
    check(
      "a detached build is never read as nothing running",
      probes > 5 && busy > 0 && notHeld === 0,
      `${probes} probes, ${notBusy} not busy (between builds), ${notHeld} with nothing held`
    )
    console.log(`     ${yield* ssh("grep -c 'BUILD SUCCEEDED' ~/build.log")} builds succeeded`)

    const device = yield* ssh("xcrun simctl list devices available | grep -m1 iPhone | grep -oE '[0-9A-F-]{36}'")
    console.log(
      `     booting ${device}: ${yield* ssh(`xcrun simctl boot ${device} && xcrun simctl bootstatus ${device} -b >/dev/null; echo booted`)}`
    )
    yield* wait(40)
    const sim1 = yield* probe("simulator-1")
    yield* wait(20)
    const sim2 = yield* probe("simulator-2")
    check(
      "a booted, idle simulator isn't use",
      sim1.simulators >= 1 && !sim1.busy && !sim2.busy && !sim1.lingering && !sim2.lingering
    )

    const before = (yield* namespace.describe(id)).deadline
    const extended = yield* namespace.extend(id, 3600)
    const described = yield* namespace.describe(id)
    check(
      "extending answers Namespace's deadline",
      extended !== undefined &&
        described.deadline !== undefined &&
        DateTime.toEpochMillis(extended) === DateTime.toEpochMillis(described.deadline),
      `${before === undefined ? "?" : DateTime.formatIso(before)} → ${extended === undefined ? "nothing" : DateTime.formatIso(extended)}`
    )
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        yield* namespace.destroy(id).pipe(Effect.ignore)
        const gone = yield* namespace.describe(id).pipe(Effect.option)
        const destroyedAt = Option.flatMapNullishOr(gone, (g) => g.destroyedAt)
        check(
          "destroyedAt is there right after the destroy",
          Option.isSome(destroyedAt),
          Option.match(destroyedAt, { onNone: () => "none", onSome: DateTime.formatIso })
        )
        console.log(`destroyed ${id}`)
      })
    )
  )
})

await Effect.runPromise(
  program.pipe(Effect.provide(Namespace.layer), Effect.provide(config), Effect.provide(FetchHttpClient.layer))
)
const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? "all checks passed" : `${failed.length} failed`)
process.exitCode = failed.length === 0 ? 0 : 1
