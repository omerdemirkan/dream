/**
 * Home shows which projects need them, not the asks themselves: questions and
 * access requests live in their project. `ListOpenAsks` stays on the API for
 * older builds, and only the fixtures backend still implements it.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { assert, describe, it } from "@effect/vitest"

const src = join(import.meta.dirname, "../src")
const files = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []
  )

describe("Home", () => {
  it("doesn't request open asks", () => {
    const callers = files(src)
      .filter((file) => !file.includes("/fake/") && !file.endsWith("Tolerant.ts"))
      .filter((file) => readFileSync(file, "utf8").includes("ListOpenAsks"))
      .map((file) => relative(src, file))
    assert.deepStrictEqual(callers, [])
  })
})
