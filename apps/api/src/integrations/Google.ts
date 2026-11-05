/**
 * Google: verifying Sign-In ID tokens (the iOS client), and the web OAuth
 * client behind the Google integration (authorize URL, code exchange, refresh).
 */
import { UpstreamFailure } from "@dream/domain"
import { Clock, Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ApiConfig, required } from "../Config.ts"
import { decodeUnverified, Jwks, verifyRs256 } from "../lib/Jwt.ts"

export class InvalidIdToken extends Data.TaggedError("InvalidIdToken")<{ readonly reason: string }> {}

export const GoogleIdentity = Schema.Struct({
  iss: Schema.Literals(["accounts.google.com", "https://accounts.google.com"]),
  aud: Schema.String,
  sub: Schema.String,
  email: Schema.String,
  email_verified: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.String),
  exp: Schema.Number
})
export type GoogleIdentity = typeof GoogleIdentity.Type

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
  token_type: Schema.optionalKey(Schema.String)
})
export type GoogleTokenResponse = typeof TokenResponse.Type

const EmailClaim = Schema.Struct({ email: Schema.optionalKey(Schema.String) })

const jwksUrl = "https://www.googleapis.com/oauth2/v3/certs"
const authorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth"
const tokenEndpoint = "https://oauth2.googleapis.com/token"
const revokeEndpoint = "https://oauth2.googleapis.com/revoke"

/** Short scope names as the agent asks for them ("gmail.readonly") → Google's scope URLs. */
export const scopeUrl = (scope: string): string =>
  scope.startsWith("https://") || scope === "openid" || scope === "email" || scope === "profile"
    ? scope
    : `https://www.googleapis.com/auth/${scope}`

/**
 * The API hosts a scope's requests go to; their HTTPS requests get the Google
 * bearer token. Calendar and Drive live on www.googleapis.com.
 */
export const hostsForScopes = (scopes: ReadonlyArray<string>): ReadonlyArray<string> => {
  const hosts = new Set<string>(["www.googleapis.com"])
  for (const raw of scopes) {
    const scope = raw.replace("https://www.googleapis.com/auth/", "")
    if (scope.startsWith("gmail")) hosts.add("gmail.googleapis.com")
    else if (scope.startsWith("spreadsheets")) hosts.add("sheets.googleapis.com")
    else if (scope.startsWith("documents")) hosts.add("docs.googleapis.com")
    else if (scope.startsWith("presentations")) hosts.add("slides.googleapis.com")
    else if (scope.startsWith("contacts") || scope.startsWith("directory") || scope.startsWith("user."))
      hosts.add("people.googleapis.com")
    else if (scope.startsWith("youtube")) hosts.add("youtube.googleapis.com")
    else if (scope.startsWith("tasks")) hosts.add("tasks.googleapis.com")
    else if (scope.startsWith("photoslibrary")) hosts.add("photoslibrary.googleapis.com")
    else if (scope.startsWith("forms")) hosts.add("forms.googleapis.com")
  }
  return [...hosts].sort()
}

/** A display label for what was granted, e.g. "Gmail" or "Google (Gmail, Calendar)". */
export const labelForScopes = (scopes: ReadonlyArray<string>): string => {
  const names = new Set<string>()
  for (const raw of scopes) {
    const scope = raw.replace("https://www.googleapis.com/auth/", "")
    const name = scope.startsWith("gmail")
      ? "Gmail"
      : scope.startsWith("calendar")
        ? "Calendar"
        : scope.startsWith("drive")
          ? "Drive"
          : scope.startsWith("spreadsheets")
            ? "Sheets"
            : scope.startsWith("documents")
              ? "Docs"
              : scope.startsWith("contacts")
                ? "Contacts"
                : scope.startsWith("youtube")
                  ? "YouTube"
                  : undefined
    if (name !== undefined) names.add(name)
  }
  const list = [...names]
  return list.length === 1 ? list[0]! : list.length === 0 ? "Google" : `Google (${list.join(", ")})`
}

export class Google extends Context.Service<
  Google,
  {
    readonly verifyIdToken: (token: string) => Effect.Effect<GoogleIdentity, InvalidIdToken | UpstreamFailure>
    readonly authorizeUrl: (options: {
      readonly state: string
      readonly scopes: ReadonlyArray<string>
      readonly loginHint?: string | undefined
    }) => Effect.Effect<string, UpstreamFailure>
    readonly exchangeCode: (
      code: string
    ) => Effect.Effect<GoogleTokenResponse & { readonly email?: string }, UpstreamFailure>
    readonly refresh: (refreshToken: string) => Effect.Effect<GoogleTokenResponse, UpstreamFailure>
    readonly revoke: (token: string) => Effect.Effect<void>
  }
>()("@dream/api/Google") {
  static readonly layer = Layer.effect(
    Google,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const http = yield* HttpClient.HttpClient
      const redirectUri = `${config.apiUrl}/oauth/google/callback`

      const upstream = (message: string) => () => new UpstreamFailure({ service: "Google", message })

      const jwks = http
        .get(jwksUrl)
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Jwks)),
          Effect.mapError(upstream("couldn't fetch Google's signing keys"))
        )
      const cachedJwks = yield* Effect.cachedWithTTL(jwks, "1 hour")

      const verifyIdToken = Effect.fn("Google.verifyIdToken")(function* (token: string) {
        const audiences = (yield* required(config.googleSignInClientIds, "Google", "GOOGLE_IOS_CLIENT_ID"))
          .split(",")
          .map((id) => id.trim())
        const payload = yield* verifyRs256(token, yield* cachedJwks).pipe(
          Effect.mapError((error) => new InvalidIdToken({ reason: error.reason }))
        )
        const identity = yield* Schema.decodeUnknownEffect(GoogleIdentity)(payload).pipe(
          Effect.mapError(() => new InvalidIdToken({ reason: "unexpected claims" }))
        )
        if (!audiences.includes(identity.aud)) return yield* new InvalidIdToken({ reason: "wrong audience" })
        const now = (yield* Clock.currentTimeMillis) / 1000
        if (identity.exp < now) return yield* new InvalidIdToken({ reason: "expired" })
        if (identity.email_verified === false) return yield* new InvalidIdToken({ reason: "email not verified" })
        return identity
      })

      const authorizeUrl = Effect.fn("Google.authorizeUrl")(function* (options: {
        readonly state: string
        readonly scopes: ReadonlyArray<string>
        readonly loginHint?: string | undefined
      }) {
        const clientId = yield* required(config.googleClientId, "Google", "GOOGLE_CLIENT_ID")
        const url = new URL(authorizeEndpoint)
        url.searchParams.set("client_id", clientId)
        url.searchParams.set("redirect_uri", redirectUri)
        url.searchParams.set("response_type", "code")
        url.searchParams.set("scope", ["openid", "email", ...options.scopes.map(scopeUrl)].join(" "))
        url.searchParams.set("access_type", "offline")
        // Always ask for consent so Google returns a refresh token even on a repeat grant.
        url.searchParams.set("prompt", "consent")
        url.searchParams.set("include_granted_scopes", "true")
        url.searchParams.set("state", options.state)
        if (options.loginHint !== undefined) url.searchParams.set("login_hint", options.loginHint)
        return url.toString()
      })

      const tokenRequest = (params: Record<string, string>) =>
        Effect.gen(function* () {
          const clientId = yield* required(config.googleClientId, "Google", "GOOGLE_CLIENT_ID")
          const secret = yield* required(config.googleClientSecret, "Google", "GOOGLE_CLIENT_SECRET")
          return yield* HttpClientRequest.post(tokenEndpoint).pipe(
            HttpClientRequest.bodyUrlParams({ ...params, client_id: clientId, client_secret: Redacted.value(secret) }),
            http.execute,
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
            Effect.mapError(upstream(`the token request (${params.grant_type}) failed`))
          )
        })

      const exchangeCode = Effect.fn("Google.exchangeCode")(function* (code: string) {
        const tokens = yield* tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri })
        // The ID token comes straight from Google over TLS, so its claims can be read without verifying it.
        const email =
          tokens.id_token === undefined
            ? Option.none<string>()
            : yield* decodeUnverified(tokens.id_token).pipe(
                Effect.flatMap((jwt) => Schema.decodeUnknownEffect(EmailClaim)(jwt.payload)),
                Effect.map((claims) => Option.fromUndefinedOr(claims.email)),
                Effect.orElseSucceed(() => Option.none<string>())
              )
        return Option.match(email, { onNone: () => tokens, onSome: (value) => ({ ...tokens, email: value }) })
      })

      const refresh = (refreshToken: string) =>
        tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken })

      const revoke = (token: string) =>
        HttpClientRequest.post(revokeEndpoint).pipe(
          HttpClientRequest.bodyUrlParams({ token }),
          http.execute,
          Effect.ignore
        )

      return Google.of({ verifyIdToken, authorizeUrl, exchangeCode, refresh, revoke })
    })
  )
}
