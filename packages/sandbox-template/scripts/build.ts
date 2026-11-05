/**
 * Build the `dream-sandbox` E2B template:
 *
 *   bun run template:build                          build and wait, streaming the logs
 *   bun run template:build --background             start the build on E2B and print its ids
 *   bun run template:build status <template> <build> [logs-offset]
 *
 * DREAM_TEMPLATE=<name> builds another template (for testing; `dream-sandbox` is built from main).
 *
 * The build is tagged `default` (what new sandboxes get) and `release-<release>`, naming the Dream it carries
 * (`/opt/dream/release.json`), so the ProjectDO can tell whether a sandbox is behind without starting one.
 * Moving `default` back to an older build (`Template.assignTags("dream-sandbox:release-<old>", "default")`) rolls
 * every sandbox back to it on its next refresh.
 *
 * Needs E2B_API_KEY. In development the key can come from an HTTPS proxy that
 * adds it (the e2b SDK ignores proxy env vars, so it's passed explicitly);
 * then any placeholder key works. `--no-cache` rebuilds every step.
 */
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { NodeRuntime } from "@effect/platform-node"
import { defaultBuildLogger, Template } from "e2b"
import { Effect } from "effect"
import { makeTemplate, minFreeDiskMb, resources, stageContext, templateName } from "../src/index.ts"

const args = process.argv.slice(2)

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}

const build = Effect.gen(function* () {
  const context = yield* Effect.acquireRelease(Effect.sync(stageContext), (dir) =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
  )
  const { release } = JSON.parse(readFileSync(join(context, "dream", "release.json"), "utf8")) as { release: string }
  const options = {
    ...resources,
    tags: ["default", `release-${release}`],
    ...connection,
    minFreeDiskMb,
    skipCache: args.includes("--no-cache"),
    onBuildLogs: defaultBuildLogger()
  }
  const started = Date.now()
  if (args.includes("--background")) {
    const info = yield* Effect.tryPromise(() =>
      Template.buildInBackground(makeTemplate(context), templateName, options)
    )
    yield* Effect.logInfo(
      `Started building ${info.name} (release ${release}): status ${info.templateId} ${info.buildId}`
    )
    return
  }
  const info = yield* Effect.tryPromise(() => Template.build(makeTemplate(context), templateName, options))
  yield* Effect.logInfo(
    `Built ${info.name} (template ${info.templateId}, build ${info.buildId}, release ${release}) in ${Math.round((Date.now() - started) / 1000)} s`
  )
})

/** Prints the build's logs from `logsOffset` on (E2B pages them), then its status. */
const status = (templateId: string, buildId: string, logsOffset: number) =>
  Effect.gen(function* () {
    let offset = logsOffset
    while (true) {
      const response = yield* Effect.tryPromise(() =>
        Template.getBuildStatus({ templateId, buildId }, { ...connection, logsOffset: offset })
      )
      for (const entry of response.logEntries) console.log(entry.toString())
      offset += response.logEntries.length
      if (response.logEntries.length === 0) {
        const reason = response.reason === undefined ? "" : `: ${response.reason.message}`
        return yield* Effect.logInfo(`Build ${buildId} is ${response.status}${reason} (next logs offset ${offset})`)
      }
    }
  })

const [command, templateId, buildId, offset] = args
const program =
  command === "status" && templateId !== undefined && buildId !== undefined
    ? status(templateId, buildId, Number(offset ?? 0))
    : build

program.pipe(Effect.scoped, NodeRuntime.runMain)
