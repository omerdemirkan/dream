/**
 * ChatGPT sign-in tokens as the Codex CLI keeps them (~/.codex/auth.json), and
 * the central refresh. Refresh tokens are single-use, so only the Worker ever
 * refreshes; sandboxes never hold them, and E2B injects the current access
 * token on chatgpt.com (ModelEgress).
 *
 * Endpoint, client id and body are from codex-rs 0.166.0
 * (login/src/auth/manager.rs, oauth/client.rs).
 */
import { UpstreamFailure } from "@dream/domain"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { describe } from "../e2b/E2B.ts"
import { ChatGptCredential } from "../db/Credentials.ts"
import { decodeUnverified } from "../lib/Jwt.ts"

export const CodexClientId = "app_EMoamEEZ73f0CkXaXp7hrann"
export const RefreshUrl = "https://auth.openai.com/oauth/token"

/** The auth.json Codex writes after `codex login --device-auth`. */
export const CodexAuthFile = Schema.Struct({
  auth_mode: Schema.optionalKey(Schema.NullOr(Schema.String)),
  OPENAI_API_KEY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tokens: Schema.Struct({
    id_token: Schema.String,
    access_token: Schema.String,
    refresh_token: Schema.String,
    account_id: Schema.optionalKey(Schema.NullOr(Schema.String))
  }),
  last_refresh: Schema.optionalKey(Schema.NullOr(Schema.String))
})
export type CodexAuthFile = typeof CodexAuthFile.Type

const RefreshResponse = Schema.Struct({
  id_token: Schema.optionalKey(Schema.String),
  access_token: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String)
})

const ExpClaim = Schema.Struct({ exp: Schema.optionalKey(Schema.Number) })
const OpenAiAuthClaims = Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  "https://api.openai.com/auth": Schema.optionalKey(
    Schema.Struct({
      chatgpt_account_id: Schema.optionalKey(Schema.String),
      chatgpt_plan_type: Schema.optionalKey(Schema.String),
      chatgpt_user_id: Schema.optionalKey(Schema.String),
      user_id: Schema.optionalKey(Schema.String)
    })
  )
})

/** Epoch ms from a JWT's `exp`, if it is a JWT with one. */
export const jwtExpiryMs = (token: string): Effect.Effect<Option.Option<number>> =>
  decodeUnverified(token).pipe(
    Effect.flatMap((jwt) => Schema.decodeUnknownEffect(ExpClaim)(jwt.payload)),
    Effect.map((claims) => Option.map(Option.fromUndefinedOr(claims.exp), (exp) => exp * 1000)),
    Effect.orElseSucceed(() => Option.none<number>())
  )

export const fromAuthFile = (file: CodexAuthFile): Effect.Effect<ChatGptCredential> =>
  Effect.gen(function* () {
    const expiry = yield* jwtExpiryMs(file.tokens.access_token)
    const claims = yield* idTokenClaims(file.tokens.id_token)
    const accountId = file.tokens.account_id ?? claims.accountId
    return {
      idToken: file.tokens.id_token,
      accessToken: file.tokens.access_token,
      refreshToken: file.tokens.refresh_token,
      ...(accountId === undefined || accountId === null ? {} : { accountId }),
      ...Option.match(expiry, { onNone: () => ({}), onSome: (ms) => ({ accessExpiresAtMs: ms }) })
    }
  })

export interface IdTokenClaims {
  readonly email?: string | undefined
  readonly accountId?: string | undefined
  readonly planType?: string | undefined
  readonly userId?: string | undefined
}

export const idTokenClaims = (idToken: string): Effect.Effect<IdTokenClaims> =>
  decodeUnverified(idToken).pipe(
    Effect.flatMap((jwt) => Schema.decodeUnknownEffect(OpenAiAuthClaims)(jwt.payload)),
    Effect.map((claims) => {
      const auth = claims["https://api.openai.com/auth"]
      return {
        email: claims.email,
        accountId: auth?.chatgpt_account_id,
        planType: auth?.chatgpt_plan_type,
        userId: auth?.chatgpt_user_id ?? auth?.user_id
      }
    }),
    Effect.orElseSucceed((): IdTokenClaims => ({}))
  )

/** "ChatGPT Pro" from a plan type like "pro". */
export const planName = (planType: string | undefined): string | undefined =>
  planType === undefined ? undefined : `ChatGPT ${planType.charAt(0).toUpperCase()}${planType.slice(1)}`

export class ChatGpt extends Context.Service<
  ChatGpt,
  {
    /** Exchanges the (single-use) refresh token for a new token set. */
    readonly refresh: (credential: ChatGptCredential) => Effect.Effect<ChatGptCredential, UpstreamFailure>
  }
>()("@dream/api/ChatGpt") {
  static readonly layer = Layer.effect(
    ChatGpt,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const refresh = Effect.fn("ChatGpt.refresh")(function* (credential: ChatGptCredential) {
        const response = yield* HttpClientRequest.post(RefreshUrl).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            client_id: CodexClientId,
            grant_type: "refresh_token",
            refresh_token: credential.refreshToken,
            refresh_reason: "scheduled"
          }),
          http.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RefreshResponse)),
          Effect.mapError(
            (cause) =>
              new UpstreamFailure({
                service: "OpenAI",
                message: `refreshing ChatGPT tokens failed: ${describe(cause)}`
              })
          )
        )
        const accessToken = response.access_token ?? credential.accessToken
        const expiry = yield* jwtExpiryMs(accessToken)
        return {
          idToken: response.id_token ?? credential.idToken,
          accessToken,
          refreshToken: response.refresh_token ?? credential.refreshToken,
          ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
          ...Option.match(expiry, { onNone: () => ({}), onSome: (ms) => ({ accessExpiresAtMs: ms }) })
        }
      })
      return ChatGpt.of({ refresh })
    })
  )
}
