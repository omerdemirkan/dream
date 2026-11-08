/**
 * GET /admin/macs/activity (the operator's `x-dream-dev-secret`): each Mac's life from its activity log
 * (`db/MacActivity.ts`). `?project=prj_…` summarizes that project's Macs of the last `days` (31 by default);
 * `?instance=<Namespace instance id>` adds every entry of that Mac, as does `&entries=1` for a project.
 */
import { ProjectId } from "@dream/domain"
import { DateTime, Effect, Option, Schema } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { MacActivity, type MacActivityFilter, MacActivityLog, summarizeMacs } from "../db/MacActivity.ts"

const encodeActivity = Schema.encodeSync(Schema.toCodecJson(MacActivity))

export const macActivity = (url: URL) =>
  Effect.gen(function* () {
    const log = yield* MacActivityLog
    const instance = url.searchParams.get("instance")
    const project = Schema.decodeUnknownOption(ProjectId)(url.searchParams.get("project"))
    const days = Math.min(400, Math.max(1, Number(url.searchParams.get("days")) || 31))
    const since = DateTime.subtract(yield* DateTime.now, { days })
    const filter: Option.Option<MacActivityFilter> =
      instance !== null
        ? Option.some({ instanceId: instance })
        : Option.map(project, (projectId) => ({ projectId, since }))
    if (Option.isNone(filter))
      return HttpServerResponse.text("Ask for ?project=prj_… or ?instance=<instance id>", { status: 400 })
    const entries = yield* log.read(filter.value)
    const withEntries = instance !== null || url.searchParams.get("entries") === "1"
    return HttpServerResponse.jsonUnsafe({
      macs: summarizeMacs(entries),
      ...(withEntries
        ? {
            entries: entries.map((entry) => ({
              instanceId: entry.instanceId,
              at: DateTime.formatIso(entry.at),
              activity: encodeActivity(entry.activity)
            }))
          }
        : {})
    })
  })
