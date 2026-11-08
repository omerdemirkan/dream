/**
 * POST /client-errors: the app's crash and error reports (`ClientErrorBatch`), stored in D1 (`db/ClientErrors.ts`).
 * No session needed, so a crash while signing in still reports; one that comes with a valid session notes whose app
 * it was. Rate-limited per address (hashed for the counter's key) and overall, so a loop in a broken build, or
 * anyone else, can't fill the table. GET /admin/client-errors (the operator's `x-dream-dev-secret`) reads them.
 */
import { ClientErrorBatch, ClientErrorKind } from "@dream/domain"
import { DateTime, Effect, Option, Schema } from "effect"
import type { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Tokens } from "../auth/Tokens.ts"
import { ClientErrors } from "../db/ClientErrors.ts"
import { RateLimits } from "../db/RateLimits.ts"
import { utf8 } from "../lib/Bytes.ts"
import { bearer } from "./AppHandlers.ts"

/** Per address, and for everyone together, per hour. */
export const clientErrorLimits = { perAddress: 30, overall: 600, windowMs: 3_600_000 } as const

const addressKey = (address: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", utf8(address))).pipe(
    Effect.map((digest) =>
      [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")
    )
  )

export const receiveClientErrors = (request: HttpServerRequest) =>
  Effect.gen(function* () {
    const limits = yield* RateLimits
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
    const address = request.headers["cf-connecting-ip"] ?? "unknown"
    const key = yield* addressKey(address)
    const allowed =
      (yield* limits.hit(`client-errors:${key}`, clientErrorLimits.perAddress, clientErrorLimits.windowMs, nowMs)) &&
      (yield* limits.hit("client-errors", clientErrorLimits.overall, clientErrorLimits.windowMs, nowMs))
    if (!allowed) return HttpServerResponse.text("Too many reports", { status: 429 })

    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null))
    const batch = Schema.decodeUnknownOption(Schema.toCodecJson(ClientErrorBatch))(body)
    if (Option.isNone(batch)) return HttpServerResponse.text("Bad report", { status: 400 })

    const tokens = yield* Tokens
    const token = bearer(request.headers)
    const session = Option.isNone(token) ? Option.none() : yield* tokens.verifySession(token.value).pipe(Effect.option)
    const store = yield* ClientErrors
    yield* store.record(batch.value.reports, Option.isSome(session) ? session.value.userId : undefined)
    yield* Effect.logWarning("client error reported", {
      count: batch.value.reports.length,
      kinds: batch.value.reports.map((r) => r.kind)
    })
    return HttpServerResponse.empty({ status: 204 })
  })

export const readClientErrors = (url: URL) =>
  Effect.gen(function* () {
    const store = yield* ClientErrors
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50))
    const kind = Schema.decodeUnknownOption(ClientErrorKind)(url.searchParams.get("kind"))
    const rows = yield* store.latest({ limit, kind: Option.getOrUndefined(kind) })
    return HttpServerResponse.jsonUnsafe({
      reports: rows.map((row) => ({
        ...row,
        received_at: DateTime.formatIso(row.received_at),
        occurred_at: DateTime.formatIso(row.occurred_at)
      }))
    })
  })
