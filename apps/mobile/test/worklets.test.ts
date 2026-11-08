/**
 * Animation callbacks run on the UI runtime, where an exception ends a release build outright (no red screen, no
 * error handler: the Reply crash on the expanded question). They hand work back to React with `scheduleOnRN(fn)`,
 * and `fn` must be a function made on the React side: a closure written inline inside the callback threw there.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"

const sources = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [join(dir, entry.name)] : []
  )

describe("scheduleOnRN", () => {
  it("is only handed functions made outside the worklet, never an inline closure", () => {
    const inline = sources(new URL("../src", import.meta.url).pathname).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /scheduleOnRN\(\s*(\([^)]*\)\s*=>|async\s|function\b)/.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []
        )
    )
    expect(inline).toEqual([])
  })
})
