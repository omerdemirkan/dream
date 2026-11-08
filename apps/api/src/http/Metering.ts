/**
 * The metering ledger's HTTP routes: E2B's lifecycle webhook (`Routes.e2bWebhook`), and the operator's route that
 * has the Worker register that webhook for itself (`Routes.meteringE2bWebhook`). See metering/E2BMetering.ts.
 */
import { Routes } from "@dream/domain"
import { DateTime, Duration, Effect } from "effect"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { ApiConfig } from "../Config.ts"
import { BackfillRetention, E2BMetering } from "../metering/E2BMetering.ts"

/**
 * Checks the signature on the raw body and records the run, then answers: a bad signature is a 401 (E2B retries it,
 * and a rotation's old secret still verifies); anything signed is a 2xx, so E2B never retries what it can't fix.
 */
export const receiveE2bWebhook = Effect.gen(function* () {
  const request = yield* HttpServerRequest
  const metering = yield* E2BMetering
  const body = yield* request.arrayBuffer.pipe(Effect.option)
  if (body._tag === "None") return HttpServerResponse.text("Unreadable body", { status: 400 })
  const outcome = yield* metering.receive(new Uint8Array(body.value), request.headers["e2b-signature"])
  switch (outcome._tag) {
    case "Unauthorized":
      return HttpServerResponse.text("Bad signature", { status: 401 })
    case "Malformed":
      yield* Effect.logWarning("an E2B webhook body didn't decode")
      return HttpServerResponse.empty({ status: 202 })
    case "Recorded":
      return HttpServerResponse.empty({ status: 204 })
  }
}).pipe(Effect.withSpan("http.e2bWebhook"))

/** `?backfill=<days>` (at most E2B's 7) also records that many days of runs from `GET /events/sandboxes`. */
export const registerE2bWebhook = (url: URL) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const metering = yield* E2BMetering
    const registered = yield* metering.register(`${config.apiUrl}${Routes.e2bWebhook}`)
    const days = Number(url.searchParams.get("backfill") ?? 0)
    const backfilled =
      Number.isFinite(days) && days > 0
        ? yield* metering.backfill(
            DateTime.subtractDuration(yield* DateTime.now, Duration.min(Duration.days(days), BackfillRetention))
          )
        : undefined
    return HttpServerResponse.jsonUnsafe({ ...registered, ...(backfilled === undefined ? {} : { backfilled }) })
  }).pipe(
    Effect.catchTag("UpstreamFailure", (e) =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ problem: `${e.service}: ${e.message}` }, { status: 502 }))
    )
  )
