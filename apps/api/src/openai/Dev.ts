/**
 * The operator's routes for checking the live gateway without running an agent (both behind `x-dream-dev-secret`):
 * a short-lived credential for a dev pseudo-project owned by Dream (`Tokens.openaiDevGateway`), whose calls are
 * metered to Dream's overhead, and what the ledger recorded for one. See
 * `packages/sandbox-template/scripts/gateway-live-check.ts`.
 */
import { Effect, Option, Redacted, Schema } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { DevProjectPrefix, Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { OperatorOwner } from "../metering/Meter.ts"
import { parseAny } from "./Json.ts"
import { OpenAIObjects } from "./Objects.ts"

const DevCredentialRequest = Schema.Struct({
  label: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/))
})
const decodeRequest = Schema.decodeUnknownOption(DevCredentialRequest)

export const devCredential = (body: unknown) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const request = decodeRequest(body)
    if (Option.isNone(request))
      return HttpServerResponse.text("Send { label } in lowercase letters, digits and dashes", { status: 400 })
    const minted = yield* (yield* Tokens).openaiDevGateway(request.value.label, OperatorOwner as never)
    return HttpServerResponse.jsonUnsafe({
      credential: Redacted.value(minted.token),
      projectId: minted.projectId,
      expiresAtMs: minted.expiresAtMs,
      enabled: config.aiGatewayEnabled,
      configured: Option.isSome(config.openaiApiKey)
    })
  })

export const devEvents = (project: string | null) =>
  Effect.gen(function* () {
    if (project === null || !project.startsWith(DevProjectPrefix))
      return HttpServerResponse.text(`Ask for ?project=${DevProjectPrefix}…`, { status: 400 })
    const rows = yield* (yield* OpenAIObjects).recorded(project)
    return HttpServerResponse.jsonUnsafe(
      rows.map((row) => ({
        id: row.id,
        owner: row.owner,
        at: row.at,
        quantities: Option.getOrUndefined(parseAny(row.quantities_json)),
        dimensions: Option.getOrUndefined(parseAny(row.dimensions_json)),
        usd: row.cost_usd
      }))
    )
  })
