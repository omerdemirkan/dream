import { assert, describe, it } from "@effect/vitest"
import { macProbeCommand, parseMacProbe } from "../src/brokers/MacProbe.ts"

const sim = "/Library/Developer/CoreSimulator/Volumes/iOS_23F77/Library/Developer/CoreSimulator/Profiles/Runtimes"

/** A Mac as the probe sees it (from a real one, 2026-11-08): the user's agents, and a booted simulator. */
const base = [
  "self 20993",
  "load { 2.10 1.80 1.50 }",
  "p 169 1 me 0.0 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow",
  "p 364 1 me 0.0 /usr/sbin/distnoted",
  "p 411 1 me 0.0 /System/Library/CoreServices/Dock.app/Contents/MacOS/Dock",
  "p 13894 1 me 9.6 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/SimMetalHost",
  "p 13895 1 me 0.1 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/bin/launchd_sim",
  `p 13947 13895 me 49.7 ${sim}/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/diagnosticd`,
  "p 20990 13895 me 20.4 /Users/runner/Library/Developer/CoreSimulator/Devices/3246/data/Containers/Bundle/Application/BB/Dream.app/Dream",
  "p 20993 317 me 1.0 /bin/sh",
  "p 20995 20993 me 0.5 /bin/ps",
  "p 20996 20993 me 0.2 /usr/bin/awk"
]
const output = (...lines: ReadonlyArray<string>) => [...base, ...lines, "cpu 112.4", "sims 1", ""].join("\n")

describe("MacProbe", () => {
  it("doesn't count a booted simulator with an app open as use, however much CPU it burns", () => {
    const probe = parseMacProbe(output())
    assert.deepStrictEqual(probe, {
      busy: false,
      sshSessions: 0,
      tools: [],
      agentProcesses: 0,
      agentCpu: 0,
      totalCpu: 112.4,
      load1: 2.1,
      simulators: 1
    })
  })

  it("counts an open ssh session, whatever its command does", () => {
    const probe = parseMacProbe(
      output(
        "p 30001 1 other 0.0 /usr/sbin/sshd",
        "p 30002 30001 other 0.0 /usr/libexec/sshd-session",
        "p 30003 30002 me 0.0 /usr/libexec/sshd-session",
        "p 30004 30003 me 0.0 /bin/zsh",
        "p 30005 30004 me 0.0 /bin/sleep"
      )
    )
    assert.isTrue(probe.busy)
    assert.strictEqual(probe.sshSessions, 1)
    assert.strictEqual(probe.agentProcesses, 2)
  })

  it("counts a build the agent left running after its session ended", () => {
    const probe = parseMacProbe(
      output(
        "p 31000 1 me 0.3 /Applications/Xcode-26.6.app/Contents/Developer/usr/bin/xcodebuild",
        "p 31001 31000 me 88.0 /Applications/Xcode-26.6.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend"
      )
    )
    assert.isTrue(probe.busy)
    assert.deepStrictEqual(probe.tools, ["swift-frontend", "xcodebuild"])
    assert.strictEqual(probe.sshSessions, 0)
  })

  it("counts a left-behind script while it works, and not a server that waits", () => {
    const working = parseMacProbe(output("p 32000 1 me 0.0 /bin/bash", "p 32001 32000 me 35.0 /opt/homebrew/bin/node"))
    assert.isTrue(working.busy)
    assert.strictEqual(working.agentCpu, 35)
    const waiting = parseMacProbe(output("p 33000 1 me 0.4 /opt/homebrew/bin/node"))
    assert.isFalse(waiting.busy)
    assert.strictEqual(waiting.agentProcesses, 1)
  })

  it("doesn't count itself, and reads what it can of a partial answer", () => {
    assert.isFalse(parseMacProbe(output()).busy)
    assert.deepStrictEqual(parseMacProbe("garbage\n"), {
      busy: false,
      sshSessions: 0,
      tools: [],
      agentProcesses: 0,
      agentCpu: 0,
      totalCpu: 0,
      simulators: 0
    })
  })

  it("runs as one sh command with a PATH of its own", () => {
    assert.strictEqual(macProbeCommand[0], "/bin/sh")
    assert.include(macProbeCommand[2], "PATH=/usr/bin:/bin:/usr/sbin:/sbin")
    assert.include(macProbeCommand[2], "ps -Ao pid=,ppid=,user=,pcpu=,comm=")
  })
})
