/**
 * The gateway's side of the project's log: what it saw of each request to a published app (`GatewayRequest`), handed
 * to the project's DO (`ProjectRpcs.LogRequests`) after the response, a few seconds' worth at a time, so a page that
 * loads thirty files costs the DO one call rather than thirty. The batch is per isolate; one the isolate doesn't live
 * to send is lost, which a log can afford.
 */
import type { ProjectId } from "@dream/domain"
import { Effect } from "effect"
import { AfterResponse } from "../openai/Runtime.ts"
import { ProjectClients } from "../project/Client.ts"
import { GatewayPathMax, type GatewayRequest } from "../project/ProjectRpcs.ts"

/** How long a batch gathers before it's sent. */
export const GatewayLogDelay = "3 seconds"
/** The most a batch holds; past it, the oldest go. */
export const GatewayLogMax = 200

/** Each project's batch, and when its send was arranged. */
const pending = new Map<ProjectId, { readonly requests: Array<GatewayRequest>; readonly sinceMs: number }>()
/** A batch whose send was arranged this long ago was lost with the work that would have sent it. */
const LostAfterMs = 30_000

/** A request's path and query, as the log keeps it. */
export const loggedPath = (url: URL): string => {
  const path = `${url.pathname}${url.search}`
  return path.length > GatewayPathMax ? `${path.slice(0, GatewayPathMax - 1)}…` : path
}

/** Note a request; the first in a batch arranges for it to be sent once the delay has passed. */
export const logRequest = (projectId: ProjectId, request: GatewayRequest) =>
  Effect.gen(function* () {
    const nowMs = Date.now()
    const batch = pending.get(projectId)
    if (batch !== undefined) {
      batch.requests.push(request)
      if (batch.requests.length > GatewayLogMax) batch.requests.splice(0, batch.requests.length - GatewayLogMax)
      if (nowMs - batch.sinceMs < LostAfterMs) return
    }
    pending.set(projectId, { requests: batch?.requests ?? [request], sinceMs: nowMs })
    const after = yield* AfterResponse
    const clients = yield* ProjectClients
    yield* after.run(
      Effect.gen(function* () {
        yield* Effect.sleep(GatewayLogDelay)
        const requests = pending.get(projectId)?.requests ?? []
        pending.delete(projectId)
        const [first, ...rest] = requests
        if (first === undefined) return
        yield* clients
          .use(projectId, (client) => client.LogRequests({ requests: [first, ...rest] }))
          .pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't log the gateway's requests", cause)))
      })
    )
  })
