/**
 * A tiny Cloudflare API client for the operator scripts in this directory.
 * Credentials come from CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (root .env).
 */
import { Config, Effect, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

export const CloudflareConfig = Config.all({
  token: Config.Redacted("CLOUDFLARE_API_TOKEN"),
  accountId: Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID")
})

const Envelope = <S extends Schema.Top>(result: S) =>
  Schema.Struct({
    success: Schema.Boolean,
    errors: Schema.Array(Schema.Struct({ message: Schema.String })),
    result: Schema.NullOr(result)
  })

export const cloudflare = <S extends Schema.Codec<any, any, never, never>>(
  method: "GET" | "PUT" | "POST",
  path: string,
  result: S,
  body?: unknown
) =>
  Effect.gen(function* () {
    const { token, accountId } = yield* CloudflareConfig
    const http = yield* HttpClient.HttpClient
    const request = HttpClientRequest.make(method)(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`
    ).pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      body === undefined ? (r) => r : HttpClientRequest.bodyJsonUnsafe(body)
    )
    const response = yield* http.execute(request)
    const decoded = yield* HttpClientResponse.schemaBodyJson(Envelope(result))(response)
    if (!decoded.success || decoded.result === null) {
      return yield* Effect.fail(new Error(decoded.errors.map((e) => e.message).join("; ") || `HTTP ${response.status}`))
    }
    return decoded.result as S["Type"]
  }).pipe(Effect.provide(FetchHttpClient.layer))
