/**
 * OAuth providers other than Google (Spotify, GitHub, Strava, …), described as
 * data. Adding one is an entry in `OAuthCatalog` (or in the `OAUTH_PROVIDERS`
 * secret, as JSON) plus Dream's client id and secret for it as the Worker
 * secrets `OAUTH_<ID>_CLIENT_ID` and `OAUTH_<ID>_CLIENT_SECRET`. The quirks
 * each provider has (PKCE, comma-separated scopes, Basic client auth, JSON
 * token bodies, Slack's nested user token) are fields here, not code.
 *
 * `OAuth` speaks the protocol: the authorize URL, the code exchange, refreshes,
 * who they signed in as, and revocation.
 */
import { InvalidRequest, UpstreamFailure } from "@dream/domain"
import { Clock, Config, Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { ApiConfig } from "../Config.ts"
import { toBase64, toBase64Url, utf8 } from "../lib/Bytes.ts"

// ---------------------------------------------------------------------------
// Provider descriptions
// ---------------------------------------------------------------------------

/** Where a provider's access token goes. `format` has `{token}`, or `{basic:<user>}` for base64("<user>:<token>"). */
export const OAuthHost = Schema.Struct({
  host: Schema.String,
  header: Schema.optionalKey(Schema.String),
  format: Schema.optionalKey(Schema.String)
})
export type OAuthHost = typeof OAuthHost.Type

export const OAuthProviderSpec = Schema.Struct({
  /** Lowercase letters, digits and dashes: the id the agent names (`dream access oauth spotify`). */
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/)),
  service: Schema.String,
  authorizeUrl: Schema.String,
  tokenUrl: Schema.String,
  /** Requested when the agent names no scopes. Empty means the provider's own default (or it has no scopes). */
  defaultScopes: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Always requested, e.g. Microsoft's `offline_access`, without which there's no refresh token. */
  extraScopes: Schema.optionalKey(Schema.Array(Schema.String)),
  /** How the scope list is joined (" " unless the provider wants ","). */
  scopeSeparator: Schema.optionalKey(Schema.String),
  /** The authorize parameter that carries scopes ("scope"; Slack's user scopes are "user_scope"). */
  scopeParam: Schema.optionalKey(Schema.String),
  /** Fixed authorize parameters, e.g. Dropbox's `token_access_type=offline`. */
  authorizeParams: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Send a PKCE (S256) challenge, for providers that support it. */
  pkce: Schema.optionalKey(Schema.Boolean),
  /** How the client authenticates at the token endpoint: HTTP Basic, or `client_id`/`client_secret` in the body. */
  clientAuth: Schema.optionalKey(Schema.Literals(["basic", "body"])),
  /** The token request body: form-encoded (the standard) or JSON (Notion). */
  tokenBody: Schema.optionalKey(Schema.Literals(["form", "json"])),
  /** Where their token sits in the token response when it isn't at the top (Slack: "authed_user"). */
  tokenPath: Schema.optionalKey(Schema.String),
  hosts: Schema.Array(OAuthHost),
  /**
   * Who they signed in as: the first of `fields` (dotted paths) that holds a string, read from `url` with their
   * new token, or from the token response when there's no `url`.
   */
  account: Schema.optionalKey(
    Schema.Struct({
      url: Schema.optionalKey(Schema.String),
      method: Schema.optionalKey(Schema.Literals(["GET", "POST"])),
      fields: Schema.Array(Schema.String)
    })
  ),
  /**
   * Revoking their grant when they disconnect it in Settings: `form` posts the token as `param` (default "token"),
   * `bearer` posts with it as a bearer token, `github` deletes the OAuth app grant.
   */
  revoke: Schema.optionalKey(
    Schema.Struct({
      url: Schema.String,
      style: Schema.Literals(["form", "bearer", "github"]),
      param: Schema.optionalKey(Schema.String)
    })
  ),
  /** Told to the agent with the connection: what else the API needs. */
  notes: Schema.optionalKey(Schema.String)
})
export type OAuthProviderSpec = typeof OAuthProviderSpec.Type

/** The providers Dream ships configured. See docs/setup/oauth-providers.md for registering Dream's app with each. */
export const OAuthCatalog: ReadonlyArray<OAuthProviderSpec> = [
  {
    id: "spotify",
    service: "Spotify",
    authorizeUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    defaultScopes: ["user-read-private"],
    pkce: true,
    clientAuth: "basic",
    hosts: [{ host: "api.spotify.com" }],
    account: { url: "https://api.spotify.com/v1/me", fields: ["display_name", "id"] },
    notes:
      "Spotify doesn't offer some endpoints to newer apps (recommendations, audio features, related artists), " +
      "so those answer 403 or 404 whatever the scopes."
  },
  {
    id: "github",
    service: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultScopes: ["read:user"],
    pkce: true,
    hosts: [
      { host: "api.github.com" },
      { host: "uploads.github.com" },
      // Git over HTTPS takes the token as a Basic password, so clone and push work with no credential helper.
      { host: "github.com", format: "Basic {basic:x-access-token}" }
    ],
    account: { url: "https://api.github.com/user", fields: ["login"] },
    revoke: { url: "https://api.github.com/applications/{client_id}/grant", style: "github" },
    notes:
      "api.github.com refuses requests without a User-Agent header. git clone, pull and push over " +
      "https://github.com/ also act as them, with no credential helper or token in the remote URL."
  },
  {
    id: "strava",
    service: "Strava",
    authorizeUrl: "https://www.strava.com/oauth/authorize",
    tokenUrl: "https://www.strava.com/oauth/token",
    defaultScopes: ["read", "activity:read_all"],
    scopeSeparator: ",",
    authorizeParams: { approval_prompt: "auto" },
    // Strava moves its API to api-v3.strava.com during 2027; both carry the token.
    hosts: [{ host: "www.strava.com" }, { host: "api-v3.strava.com" }],
    account: { fields: ["athlete.username", "athlete.firstname"] },
    revoke: { url: "https://www.strava.com/oauth/deauthorize", style: "form", param: "access_token" },
    notes:
      "The API is at https://www.strava.com/api/v3 (moving to https://api-v3.strava.com in 2027). " +
      "Strava rate-limits each app as a whole (by default 100 reads " +
      "per 15 minutes and 1,000 a day), shared by everyone connected to Dream's app, so cache what you fetch."
  },
  {
    id: "dropbox",
    service: "Dropbox",
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    defaultScopes: [],
    authorizeParams: { token_access_type: "offline" },
    pkce: true,
    hosts: [{ host: "api.dropboxapi.com" }, { host: "content.dropboxapi.com" }],
    account: {
      url: "https://api.dropboxapi.com/2/users/get_current_account",
      method: "POST",
      fields: ["email", "name.display_name"]
    },
    revoke: { url: "https://api.dropboxapi.com/2/auth/token/revoke", style: "bearer" },
    notes:
      "File contents (/2/files/download, /2/files/upload) go to content.dropboxapi.com; everything else to " +
      "api.dropboxapi.com. With no scopes named, Dream's app grants what it's configured with."
  },
  {
    id: "slack",
    service: "Slack",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    defaultScopes: ["users:read"],
    scopeSeparator: ",",
    scopeParam: "user_scope",
    tokenPath: "authed_user",
    hosts: [{ host: "slack.com" }, { host: "files.slack.com" }],
    account: { fields: ["team.name"] },
    revoke: { url: "https://slack.com/api/auth.revoke", style: "form" },
    notes:
      "Scopes are Slack user scopes, and calls act as them in that workspace: what you post appears under their " +
      "name. The Web API is https://slack.com/api/<method>; private file URLs on files.slack.com work too. Slack " +
      "throttles conversations.history and conversations.replies hard for apps outside its Marketplace, so read " +
      "history sparingly and keep what you've read."
  },
  {
    id: "notion",
    service: "Notion",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    defaultScopes: [],
    authorizeParams: { owner: "user" },
    clientAuth: "basic",
    tokenBody: "json",
    hosts: [{ host: "api.notion.com" }],
    account: { fields: ["workspace_name"] },
    notes:
      "Notion has no scopes: it sees only the pages they picked when they connected, and connecting again lets " +
      "them pick more. Every request needs a Notion-Version header, such as 2022-06-28."
  },
  {
    id: "microsoft",
    service: "Microsoft",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    defaultScopes: ["User.Read"],
    extraScopes: ["offline_access"],
    pkce: true,
    hosts: [{ host: "graph.microsoft.com" }],
    account: { url: "https://graph.microsoft.com/v1.0/me", fields: ["mail", "userPrincipalName"] },
    notes:
      "Scopes are Microsoft Graph permissions (Mail.Read, Calendars.ReadWrite, Files.ReadWrite, …), and " +
      "everything goes through https://graph.microsoft.com, for personal and work accounts alike."
  },
  {
    id: "oura",
    service: "Oura",
    authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
    tokenUrl: "https://api.ouraring.com/oauth/token",
    defaultScopes: ["personal", "daily"],
    hosts: [{ host: "api.ouraring.com" }],
    account: { url: "https://api.ouraring.com/v2/usercollection/personal_info", fields: ["email"] },
    notes: "The API is https://api.ouraring.com/v2/usercollection/…; most data needs an active Oura membership."
  }
]

/** `OAUTH_<ID>_CLIENT_ID`, with dashes as underscores. */
export const clientSecretNames = (id: string) => {
  const base = `OAUTH_${id.toUpperCase().replaceAll("-", "_")}`
  return { clientId: `${base}_CLIENT_ID`, clientSecret: `${base}_CLIENT_SECRET` }
}

export interface OAuthClientCredentials {
  readonly id: string
  readonly secret: Redacted.Redacted<string>
}

export interface OAuthProvider {
  readonly spec: OAuthProviderSpec
  /** Absent until the operator sets both Worker secrets. */
  readonly client: Option.Option<OAuthClientCredentials>
}

/** A provider this deployment has registered Dream's app with. */
export interface ReadyOAuthProvider {
  readonly spec: OAuthProviderSpec
  readonly client: OAuthClientCredentials
}

export const placeholderFor = (id: string) => `dream-${id}-oauth-placeholder`

export const scopesFor = (spec: OAuthProviderSpec, requested: ReadonlyArray<string>): ReadonlyArray<string> =>
  requested.length > 0 ? requested : (spec.defaultScopes ?? [])

/** What a provider's token puts on each of its hosts. */
export const headersFor = (
  spec: Pick<OAuthProviderSpec, "hosts">,
  token: string
): ReadonlyArray<readonly [string, string, string]> =>
  spec.hosts.map(({ host, header, format }) => [
    host,
    header ?? "Authorization",
    (format ?? "Bearer {token}")
      .replace(/\{basic:([^}]*)\}/g, (_, user: string) => toBase64(utf8(`${user}:${token}`)))
      .replaceAll("{token}", token)
  ])

// ---------------------------------------------------------------------------
// Which providers this deployment has
// ---------------------------------------------------------------------------

export class OAuthProviders extends Context.Service<
  OAuthProviders,
  {
    readonly all: ReadonlyArray<OAuthProvider>
    /**
     * The provider with Dream's client credentials. `InvalidRequest` when Dream doesn't know it, and when this
     * deployment hasn't registered an app with it; both messages are written for the agent.
     */
    readonly configured: (id: string) => Effect.Effect<ReadyOAuthProvider, InvalidRequest>
    /** The description, configured or not (rows can outlive configuration). */
    readonly spec: (id: string) => Option.Option<OAuthProviderSpec>
  }
>()("@dream/api/OAuthProviders") {
  static readonly make = (all: ReadonlyArray<OAuthProvider>) => {
    const byId = new Map(all.map((provider) => [provider.spec.id, provider]))
    const names = (list: ReadonlyArray<OAuthProvider>) => list.map((provider) => provider.spec.id).join(", ")
    const ready = all.filter((provider) => Option.isSome(provider.client))
    const readyLine =
      ready.length === 0 ? "None are set up on this deployment yet." : `Set up on this deployment: ${names(ready)}.`
    return OAuthProviders.of({
      all,
      spec: (id) => Option.map(Option.fromUndefinedOr(byId.get(id.toLowerCase())), (provider) => provider.spec),
      configured: (id) => {
        const provider = byId.get(id.toLowerCase())
        if (provider === undefined) {
          return Effect.fail(
            new InvalidRequest({
              message:
                `Dream has no OAuth provider called "${id}". It knows ${names(all)}. ${readyLine} ` +
                "For a service that hands out a lasting API key, use `dream access key`."
            })
          )
        }
        if (Option.isNone(provider.client)) {
          return Effect.fail(
            new InvalidRequest({
              message:
                `${provider.spec.service} sign-in isn't set up on this deployment of Dream yet: whoever runs it ` +
                `hasn't registered Dream's ${provider.spec.service} app, so they can't connect it, and no card ` +
                `was shown. ${readyLine}`
            })
          )
        }
        return Effect.succeed({ spec: provider.spec, client: provider.client.value })
      }
    })
  }

  /** The catalog plus `OAUTH_PROVIDERS` (a JSON array of specs that add or replace by id), with their secrets. */
  static readonly layer = Layer.effect(
    OAuthProviders,
    Effect.gen(function* () {
      const extra = yield* Config.option(Config.String("OAUTH_PROVIDERS")).pipe(Effect.orDie)
      let specs = [...OAuthCatalog]
      if (Option.isSome(extra)) {
        const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(OAuthProviderSpec)))(extra.value)
        if (Option.isSome(decoded)) {
          const ids = new Set(decoded.value.map((spec) => spec.id))
          specs = [...specs.filter((spec) => !ids.has(spec.id)), ...decoded.value]
        } else {
          yield* Effect.logWarning("OAUTH_PROVIDERS isn't a JSON array of provider descriptions; ignoring it")
        }
      }
      const all = yield* Effect.forEach(specs, (spec) =>
        Effect.gen(function* () {
          const names = clientSecretNames(spec.id)
          const id = yield* Config.option(Config.NonEmptyString(names.clientId)).pipe(Effect.orDie)
          const secret = yield* Config.option(Config.Redacted(names.clientSecret)).pipe(Effect.orDie)
          const client =
            Option.isSome(id) && Option.isSome(secret) && Redacted.value(secret.value).length > 0
              ? Option.some({ id: id.value, secret: secret.value })
              : Option.none()
          return { spec, client }
        })
      )
      return OAuthProviders.make(all)
    })
  )

  /** Every catalog provider, with test credentials for those in `configured`. */
  static readonly layerTest = (configured: ReadonlyArray<string>, extra: ReadonlyArray<OAuthProviderSpec> = []) =>
    Layer.succeed(
      OAuthProviders,
      OAuthProviders.make(
        [...OAuthCatalog, ...extra].map((spec) => ({
          spec,
          client: configured.includes(spec.id)
            ? Option.some({ id: `${spec.id}-client`, secret: Redacted.make(`${spec.id}-secret`) })
            : Option.none()
        }))
      )
    )
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

/** The provider refused the grant or refresh token: they revoked it, or it lapsed. Connecting again fixes it. */
export class OAuthRejected extends Data.TaggedError("OAuthRejected")<{
  readonly service: string
  readonly reason: string
}> {}

export interface OAuthTokens {
  readonly accessToken: string
  readonly refreshToken?: string | undefined
  /** Absent when the token doesn't expire (GitHub OAuth apps, Notion). */
  readonly expiresAtMs?: number | undefined
  /** Granted scopes, in the provider's names, when it says. */
  readonly scopes?: ReadonlyArray<string> | undefined
  /** The whole token response, for reading the account from. */
  readonly response: unknown
}

const TokenFields = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Union([Schema.Number, Schema.NumberFromString])),
  expires_at: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String)
})

const ErrorFields = Schema.Struct({
  ok: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.Unknown),
  error_description: Schema.optionalKey(Schema.String)
})

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

const childAt = (value: unknown, key: string): unknown =>
  Option.getOrUndefined(Option.map(Schema.decodeUnknownOption(JsonObject)(value), (object) => object[key]))

/** The value at a dotted path, if it's a non-empty string. */
export const stringAt = (value: unknown, path: string): string | undefined => {
  const found = path.split(".").reduce(childAt, value)
  return typeof found === "string" && found.length > 0 ? found : undefined
}

/** Error codes that mean the grant itself is gone, rather than Dream's app being misconfigured. */
const clientErrors = new Set(["invalid_client", "unauthorized_client", "invalid_client_id", "bad_client_secret"])

const pkceChallenge = (verifier: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", utf8(verifier))).pipe(
    Effect.map((digest) => toBase64Url(new Uint8Array(digest)))
  )

export class OAuth extends Context.Service<
  OAuth,
  {
    readonly redirectUri: (spec: OAuthProviderSpec) => string
    readonly authorizeUrl: (
      provider: ReadyOAuthProvider,
      options: {
        readonly state: string
        readonly scopes: ReadonlyArray<string>
        readonly codeVerifier?: string | undefined
      }
    ) => Effect.Effect<string>
    readonly exchangeCode: (
      provider: ReadyOAuthProvider,
      code: string,
      codeVerifier?: string | undefined
    ) => Effect.Effect<OAuthTokens, OAuthRejected | UpstreamFailure>
    readonly refresh: (
      provider: ReadyOAuthProvider,
      refreshToken: string
    ) => Effect.Effect<OAuthTokens, OAuthRejected | UpstreamFailure>
    /** Who they signed in as, if the provider says. Never fails. */
    readonly account: (provider: ReadyOAuthProvider, tokens: OAuthTokens) => Effect.Effect<Option.Option<string>>
    /** Best effort. */
    readonly revoke: (provider: ReadyOAuthProvider, accessToken: string) => Effect.Effect<void>
  }
>()("@dream/api/OAuth") {
  static readonly layer = Layer.effect(
    OAuth,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const http = yield* HttpClient.HttpClient

      const redirectUri = (spec: OAuthProviderSpec) => `${config.apiUrl}/oauth/${spec.id}/callback`

      const authorizeUrl = Effect.fn("OAuth.authorizeUrl")(function* (
        provider: ReadyOAuthProvider,
        options: {
          readonly state: string
          readonly scopes: ReadonlyArray<string>
          readonly codeVerifier?: string | undefined
        }
      ) {
        const { spec, client } = provider
        const url = new URL(spec.authorizeUrl)
        url.searchParams.set("client_id", client.id)
        url.searchParams.set("redirect_uri", redirectUri(spec))
        url.searchParams.set("response_type", "code")
        const scopes = [...new Set([...options.scopes, ...(spec.extraScopes ?? [])])]
        if (scopes.length > 0) url.searchParams.set(spec.scopeParam ?? "scope", scopes.join(spec.scopeSeparator ?? " "))
        for (const [key, value] of Object.entries(spec.authorizeParams ?? {})) url.searchParams.set(key, value)
        url.searchParams.set("state", options.state)
        if (spec.pkce === true && options.codeVerifier !== undefined) {
          url.searchParams.set("code_challenge", yield* pkceChallenge(options.codeVerifier))
          url.searchParams.set("code_challenge_method", "S256")
        }
        return url.toString()
      })

      const readTokens = (spec: OAuthProviderSpec, response: HttpClientResponse.HttpClientResponse, nowMs: number) =>
        Effect.gen(function* () {
          const body = yield* response.json.pipe(Effect.orElseSucceed((): unknown => undefined))
          const errors = Schema.decodeUnknownOption(ErrorFields)(body)
          const reported = Option.flatMap(errors, (fields) =>
            fields.ok === false || fields.error !== undefined
              ? Option.some(typeof fields.error === "string" ? fields.error : (fields.error_description ?? "error"))
              : Option.none()
          )
          if (Option.isSome(reported) && clientErrors.has(reported.value)) {
            return yield* new UpstreamFailure({
              service: spec.service,
              message: `${spec.service} refused Dream's client id or secret (${reported.value})`
            })
          }
          if (response.status >= 500 || response.status === 429) {
            return yield* new UpstreamFailure({
              service: spec.service,
              message: `the token endpoint answered ${response.status}`
            })
          }
          if (response.status >= 400 || Option.isSome(reported)) {
            return yield* new OAuthRejected({
              service: spec.service,
              reason: Option.getOrElse(reported, () => `status ${response.status}`)
            })
          }
          // Slack puts the user's token under `authed_user`; its refreshes answer at the top level.
          const nested = spec.tokenPath === undefined ? undefined : childAt(body, spec.tokenPath)
          const source = stringAt(nested, "access_token") === undefined ? body : nested
          const fields = yield* Schema.decodeUnknownEffect(TokenFields)(source).pipe(
            Effect.mapError(
              () => new UpstreamFailure({ service: spec.service, message: "the token response had no access token" })
            )
          )
          const expiresAtMs =
            fields.expires_at !== undefined
              ? fields.expires_at * 1000
              : fields.expires_in !== undefined
                ? nowMs + fields.expires_in * 1000
                : undefined
          const scopes =
            fields.scope === undefined
              ? undefined
              : fields.scope
                  .split(/[\s,]+/)
                  .map((scope) => scope.trim())
                  .filter((scope) => scope.length > 0)
          return {
            accessToken: fields.access_token,
            refreshToken: fields.refresh_token,
            expiresAtMs,
            scopes,
            response: body
          } satisfies OAuthTokens
        })

      const tokenRequest = (provider: ReadyOAuthProvider, params: Record<string, string>) =>
        Effect.gen(function* () {
          const { spec, client } = provider
          const auth = spec.clientAuth ?? "body"
          const body =
            auth === "body" ? { ...params, client_id: client.id, client_secret: Redacted.value(client.secret) } : params
          let request = HttpClientRequest.post(spec.tokenUrl).pipe(HttpClientRequest.acceptJson)
          if (auth === "basic") request = HttpClientRequest.basicAuth(request, client.id, client.secret)
          request =
            spec.tokenBody === "json"
              ? HttpClientRequest.bodyJsonUnsafe(request, body)
              : HttpClientRequest.bodyUrlParams(request, body)
          const response = yield* http
            .execute(request)
            .pipe(
              Effect.mapError(
                () => new UpstreamFailure({ service: spec.service, message: `couldn't reach ${spec.service}` })
              )
            )
          return yield* readTokens(spec, response, yield* Clock.currentTimeMillis)
        }).pipe(
          Effect.withSpan("OAuth.token", { attributes: { provider: provider.spec.id, grant: params.grant_type } })
        )

      const exchangeCode = (provider: ReadyOAuthProvider, code: string, codeVerifier?: string | undefined) =>
        tokenRequest(provider, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri(provider.spec),
          ...(provider.spec.pkce === true && codeVerifier !== undefined ? { code_verifier: codeVerifier } : {})
        })

      const refresh = (provider: ReadyOAuthProvider, refreshToken: string) =>
        tokenRequest(provider, { grant_type: "refresh_token", refresh_token: refreshToken })

      const account = (provider: ReadyOAuthProvider, tokens: OAuthTokens) =>
        Effect.gen(function* () {
          const spec = provider.spec.account
          if (spec === undefined) return Option.none<string>()
          let source: unknown = tokens.response
          if (spec.url !== undefined) {
            const request = HttpClientRequest.make(spec.method ?? "GET")(spec.url).pipe(
              HttpClientRequest.bearerToken(tokens.accessToken),
              HttpClientRequest.acceptJson,
              HttpClientRequest.setHeader("user-agent", "Dream")
            )
            source = yield* http.execute(request).pipe(Effect.flatMap((response) => response.json))
          }
          for (const field of spec.fields) {
            const value = stringAt(source, field)
            if (value !== undefined) return Option.some(value)
          }
          return Option.none<string>()
        }).pipe(Effect.orElseSucceed(() => Option.none<string>()))

      const revoke = (provider: ReadyOAuthProvider, accessToken: string) =>
        Effect.gen(function* () {
          const spec = provider.spec.revoke
          if (spec === undefined) return
          const client = provider.client
          const request =
            spec.style === "github"
              ? HttpClientRequest.make("DELETE")(spec.url.replace("{client_id}", encodeURIComponent(client.id))).pipe(
                  HttpClientRequest.basicAuth(client.id, client.secret),
                  HttpClientRequest.acceptJson,
                  HttpClientRequest.setHeader("user-agent", "Dream"),
                  HttpClientRequest.bodyJsonUnsafe({ access_token: accessToken })
                )
              : spec.style === "bearer"
                ? HttpClientRequest.post(spec.url).pipe(HttpClientRequest.bearerToken(accessToken))
                : HttpClientRequest.post(spec.url).pipe(
                    HttpClientRequest.bodyUrlParams({ [spec.param ?? "token"]: accessToken })
                  )
          yield* http.execute(request)
        }).pipe(Effect.ignore)

      return OAuth.of({ redirectUri, authorizeUrl, exchangeCode, refresh, account, revoke })
    })
  )
}
