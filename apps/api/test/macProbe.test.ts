import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { macProbeCommand, parseMacProbe } from "../src/brokers/MacProbe.ts"

/** What the probe printed on a real Namespace Mac (macOS 27, 2026-11-08, `scripts/mac-check.ts`'s states). */
const real = (name: string) =>
  parseMacProbe(readFileSync(new URL(`./fixtures/mac-probe/${name}.txt`, import.meta.url), "utf8"))

describe("MacProbe on a real Mac", () => {
  it("reads a fresh Mac as idle, though one of macOS's daemons runs under a bare name", () => {
    const probe = real("idle")
    assert.isFalse(probe.busy)
    assert.isFalse(probe.lingering)
    assert.strictEqual(probe.agentProcesses, 0)
  })

  it("sees a command running over ssh, which Namespace's agent runs rather than sshd", () => {
    const probe = real("ssh-open")
    assert.isTrue(probe.busy)
    assert.strictEqual(probe.sshSessions, 1)
  })

  it("holds for what an ssh command left running, quiet as it is", () => {
    const probe = real("left-behind")
    assert.isFalse(probe.busy)
    assert.isTrue(probe.lingering)
    assert.strictEqual(probe.sshSessions, 0)
  })

  it("reads a build started detached as busy, and its script between builds as held", () => {
    const building = real("building")
    assert.isTrue(building.busy)
    assert.include(building.tools, "xcodebuild")
    assert.strictEqual(building.sshSessions, 0)
    const between = real("between-builds")
    assert.isFalse(between.busy)
    assert.isTrue(between.lingering)
  })

  it("doesn't count a booted simulator with an app open, at two cores of CPU", () => {
    const probe = real("simulator")
    assert.strictEqual(probe.simulators, 1)
    assert.isAbove(probe.totalCpu, 150)
    assert.isFalse(probe.busy)
    assert.isFalse(probe.lingering)
  })
})

describe("MacProbe", () => {
  const output = (...lines: ReadonlyArray<string>) =>
    ["self 900 578", "load { 2.10 1.80 1.50 }", ...lines, "cpu 12.0", "sims 0", ""].join("\n")

  it("counts what a left-behind script runs while it works, and holds for a server that waits", () => {
    const working = parseMacProbe(output("p 32000 1 578 me 0.0 /bin/bash", "p 32001 32000 578 me 35.0 node"))
    assert.isTrue(working.busy)
    assert.strictEqual(working.agentCpu, 35)
    const waiting = parseMacProbe(output("p 33000 1 578 me 0.4 /opt/homebrew/bin/node"))
    assert.isFalse(waiting.busy)
    assert.isTrue(waiting.lingering)
  })

  it("counts a session under a plain sshd too", () => {
    const probe = parseMacProbe(
      output(
        "p 30002 1 30002 other 0.0 /usr/libexec/sshd-session",
        "p 30003 30002 30002 me 0.0 /usr/libexec/sshd-session",
        "p 30004 30003 30004 me 0.0 /bin/zsh"
      )
    )
    assert.isTrue(probe.busy)
    assert.strictEqual(probe.sshSessions, 1)
  })

  it("doesn't count itself, and reads what it can of a partial answer", () => {
    assert.isFalse(parseMacProbe(output("p 901 900 578 me 1.0 /bin/ps")).busy)
    assert.deepStrictEqual(parseMacProbe("garbage\n"), {
      busy: false,
      sshSessions: 0,
      tools: [],
      agentProcesses: 0,
      agentCpu: 0,
      lingering: false,
      totalCpu: 0,
      simulators: 0
    })
  })

  it("runs as one sh command with a PATH of its own", () => {
    assert.strictEqual(macProbeCommand[0], "/bin/sh")
    assert.include(macProbeCommand[2], "PATH=/usr/bin:/bin:/usr/sbin:/sbin")
    assert.include(macProbeCommand[2], "ps -Ao pid=,ppid=,pgid=,user=,pcpu=,comm=")
  })
})
