/**
 * Build the `dream-sandbox` E2B template: `bun run template:build`.
 *
 * Needs E2B_API_KEY. In development the key can come from an HTTPS proxy that
 * adds it (the e2b SDK ignores proxy env vars, so it's passed explicitly);
 * then any placeholder key works. `--no-cache` rebuilds every step.
 */
import { rmSync } from "node:fs"
import { NodeRuntime } from "@effect/platform-node"
import { defaultBuildLogger, Template } from "e2b"
import { Effect } from "effect"
import { makeTemplate, minFreeDiskMb, resources, stageContext, templateName } from "../src/index.ts"

const build = Effect.gen(function* () {
  const context = yield* Effect.acquireRelease(Effect.sync(stageContext), (dir) =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
  )
  const started = Date.now()
  const info = yield* Effect.tryPromise(() =>
    Template.build(makeTemplate(context), templateName, {
      ...resources,
      minFreeDiskMb,
      skipCache: process.argv.includes("--no-cache"),
      apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
      ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY }),
      onBuildLogs: defaultBuildLogger()
    })
  )
  yield* Effect.logInfo(
    `Built ${info.name} (template ${info.templateId}, build ${info.buildId}) in ${Math.round((Date.now() - started) / 1000)} s`
  )
})

build.pipe(Effect.scoped, NodeRuntime.runMain)
