import { ClientErrorLimits } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { decodeBatch, encodeBatch, errorReport, makeReportGate, screenOf } from "../src/data/errorReports.ts"

const build = { version: "1.0.0", build: "26858598", updateId: "0193-abc", channel: "production", os: "ios 26.1" }
const now = DateTime.makeUnsafe("2026-11-08T19:00:00Z")

describe("error reports", () => {
  it("keeps the error and where it happened, not the route's query", () => {
    const thrown = new TypeError("undefined is not a function")
    const report = errorReport({
      kind: "fatal",
      thrown,
      screen: "/project/prj_liftlog?thread=msg_x&draft=hello",
      build,
      now
    })
    assert.strictEqual(report.message, "TypeError: undefined is not a function")
    assert.strictEqual(report.stack, thrown.stack)
    assert.strictEqual(report.screen, "/project/prj_liftlog")
    assert.deepStrictEqual(report.build, build)
    assert.strictEqual(screenOf(undefined), undefined)
  })

  it("describes anything thrown, and cuts long text to the limits", () => {
    assert.strictEqual(errorReport({ kind: "rejection", thrown: "nope", build, now }).message, "nope")
    assert.strictEqual(
      errorReport({ kind: "rejection", thrown: { code: 3 }, build, now }).message,
      'Non-error thrown: {"code":3}'
    )
    const long = errorReport({
      kind: "render",
      thrown: new Error("x".repeat(5000)),
      componentStack: "y".repeat(20000),
      build,
      now
    })
    assert.strictEqual(long.message.length, ClientErrorLimits.message)
    assert.strictEqual(long.componentStack?.length, ClientErrorLimits.stack)
  })

  it("round-trips what a crash keeps on disk, and ignores a file it can't read", () => {
    const report = errorReport({ kind: "fatal", thrown: new Error("boom"), screen: "/", build, now })
    assert.deepStrictEqual(decodeBatch(encodeBatch([report])), [report])
    assert.deepStrictEqual(decodeBatch('{"reports":[{'), [])
  })

  it("doesn't send the same error again within a minute, nor more than a launch's worth", () => {
    const gate = makeReportGate(3, 60_000)
    const a = errorReport({ kind: "error", thrown: new Error("a"), build, now })
    const b = errorReport({ kind: "error", thrown: new Error("b"), build, now })
    assert.isTrue(gate(a, 0))
    assert.isFalse(gate(a, 30_000))
    assert.isTrue(gate(a, 61_000))
    assert.isTrue(gate(b, 61_000))
    assert.isFalse(gate(errorReport({ kind: "error", thrown: new Error("c"), build, now }), 62_000))
    // A fatal one always goes.
    assert.isTrue(gate({ ...a, kind: "fatal" }, 62_000))
  })
})
