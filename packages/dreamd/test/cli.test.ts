import { assert, describe, it } from "@effect/vitest"
import { dreamSkill } from "@dream/agent-context"
import { DateTime, Option, Result } from "effect"
import { checkCron, mediaType, parseAt, parseStep, planCopy } from "../src/cli/Parse.ts"
import { requestedTags } from "../src/Servers.ts"
import { parseSkill } from "../src/harness/Skill.ts"
import { harnessAuth, harnessEnv } from "../src/harness/HarnessEnv.ts"

const now = DateTime.makeUnsafe("2026-11-05T10:00:00Z")
const at = (input: string) => Result.map(parseAt(input, now), DateTime.formatIso)

describe("dream wake --at", () => {
  it("takes spans from now", () => {
    assert.deepStrictEqual(at("30m"), Result.succeed("2026-11-05T10:30:00.000Z"))
    assert.deepStrictEqual(at("in 1h30m"), Result.succeed("2026-11-05T11:30:00.000Z"))
    assert.deepStrictEqual(at("+2d"), Result.succeed("2026-11-07T10:00:00.000Z"))
  })

  it("takes ISO times with a zone, and refuses ones without", () => {
    assert.deepStrictEqual(at("2026-11-06T07:00:00-08:00"), Result.succeed("2026-11-06T15:00:00.000Z"))
    assert.deepStrictEqual(at("2026-11-06T07:00Z"), Result.succeed("2026-11-06T07:00:00.000Z"))
    assert.isTrue(Result.isFailure(at("2026-11-06T07:00")))
    assert.isTrue(Result.isFailure(at("tomorrow")))
  })

  it("checks cron expressions", () => {
    assert.isTrue(Result.isSuccess(checkCron("0 7 * * *")))
    assert.isTrue(Result.isFailure(checkCron("0 7 * *")))
    assert.isTrue(Result.isFailure(checkCron("99 7 * * *")))
  })
})

describe("other flags", () => {
  it("reads steps and media types", () => {
    assert.deepStrictEqual(parseStep("3/5"), Result.succeed({ current: 3, total: 5 }))
    assert.deepStrictEqual(mediaType("shot.PNG"), Result.succeed("image/png"))
    assert.isTrue(Result.isFailure(mediaType("notes.txt")))
  })
})

describe("dream mac cp", () => {
  it("copies to or from the Mac, never both or neither", () => {
    assert.deepStrictEqual(
      planCopy(["App", "project.yml", "mac:src"]),
      Result.succeed({ direction: "to-mac", sources: ["App", "project.yml"], destination: "src" })
    )
    assert.deepStrictEqual(
      planCopy(["mac:shot.png", "."]),
      Result.succeed({ direction: "from-mac", sources: ["shot.png"], destination: "." })
    )
    assert.isTrue(Result.isFailure(planCopy(["a", "b"])))
    assert.isTrue(Result.isFailure(planCopy(["mac:a", "mac:b"])))
    assert.isTrue(Result.isFailure(planCopy(["mac:a", "b", "c"])))
    assert.isTrue(Result.isFailure(planCopy(["mac:a"])))
  })
})

describe("the CLI socket", () => {
  it("sees which RPCs a request body calls", () => {
    const body = [
      JSON.stringify({ _tag: "Request", id: "1", tag: "SendMessage", payload: {}, headers: [] }),
      JSON.stringify({ _tag: "Request", id: "2", tag: "ReportUsage", payload: {}, headers: [] }),
      JSON.stringify({ _tag: "Ack", requestId: "1" }),
      "not json"
    ].join("\n")
    assert.deepStrictEqual(requestedTags(body), ["SendMessage", "ReportUsage"])
  })
})

describe("the harness environment", () => {
  it("keeps dreamd's tokens out of the agent's processes", () => {
    const env = harnessEnv(
      { PATH: "/usr/bin", DREAM_PROJECT_TOKEN: "p", DREAM_DAEMON_TOKEN: "d", DREAM_SOCKET: "/tmp/dreamd.sock" },
      { HOME: "/home/user" }
    )
    assert.deepStrictEqual(env, { PATH: "/usr/bin", DREAM_SOCKET: "/tmp/dreamd.sock", HOME: "/home/user" })
  })

  it("gives each harness a placeholder credential and no refreshable login", () => {
    assert.deepStrictEqual(Object.keys(harnessAuth("claude-code")), ["CLAUDE_CODE_OAUTH_TOKEN"])
    assert.deepStrictEqual(harnessAuth("codex"), {
      CODEX_API_KEY: "dream-placeholder",
      OPENAI_BASE_URL: "https://chatgpt.com/backend-api/codex"
    })
  })

  it("installs the dream skill with its name and description", () => {
    const skill = Option.getOrThrow(parseSkill(dreamSkill))
    assert.strictEqual(skill.name, "dream")
    assert.include(skill.description, "Reaching the person and Dream")
    assert.isTrue(skill.content.startsWith("# `dream`"))
  })
})
