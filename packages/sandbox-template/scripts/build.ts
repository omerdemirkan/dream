/**
 * Build the `dream-sandbox` E2B template:
 *
 *   bun run template:build                          build, check, and make it the build new sandboxes get
 *   bun run template:build --background             start the build on E2B and print its ids
 *   bun run template:build status <template> <build> [logs-offset]
 *   bun run template:build promote <release>        check a finished build and make it the current one
 *
 * DREAM_TEMPLATE=<name> builds another template (for testing; `dream-sandbox` is built from main).
 *
 * The build is tagged `release-<release>`, naming the Dream it carries (`/opt/dream/release.json`), so the
 * ProjectDO can tell whether a sandbox is behind without starting one. Every sandbox follows the `default` tag
 * (new ones are created from it, existing ones are refreshed to it), so a build gets `default` only once a turn on
 * each harness has run in it (`harness-check.ts`); `--no-check` skips that. Moving `default` back to an older
 * build (`promote <old release>`) rolls every sandbox back to it on its next refresh.
 *
 * Needs E2B_API_KEY. In development the key can come from an HTTPS proxy that
 * adds it (the e2b SDK ignores proxy env vars, so it's passed explicitly);
 * then any placeholder key works. `--no-cache` rebuilds every step.
 */
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { NodeRuntime } from "@effect/platform-node"
import { defaultBuildLogger, Template } from "e2b"
import { checkTemplate, report } from "./harness-check.ts"
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
    tags: [`release-${release}`],
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
  yield* promote(release, args.includes("--no-check"))
})

/** Checks the build tagged `release-<release>` (unless `skipCheck`), then tags it `default`. */
const promote = (release: string, skipCheck = false) =>
  Effect.gen(function* () {
    const target = `${templateName}:release-${release}`
    if (!skipCheck) {
      yield* Effect.logInfo(`Running a turn on each harness in ${target}`)
      const results = yield* Effect.tryPromise(() => checkTemplate(target))
      console.log(report(results))
      if (results.some((result) => !result.ok)) {
        return yield* Effect.die(new Error(`${target} failed its harness check; the current build stays current`))
      }
    }
    yield* Effect.tryPromise(() => Template.assignTags(target, "default", connection))
    yield* Effect.logInfo(`${target} is now ${templateName}'s current build`)
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
    : command === "promote" && templateId !== undefined
      ? promote(templateId.replace(/^release-/, ""), args.includes("--no-check"))
      : build

program.pipe(Effect.scoped, NodeRuntime.runMain)
