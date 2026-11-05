/**
 * Connecting an integration in answer to an access request: Google OAuth,
 * another OAuth provider, a pasted key, or an App Store Connect key. Each becomes an encrypted secret,
 * an integration record, an `AccessConnected` event for the agent, and new
 * egress rules in every one of their sandboxes.
 *
 * A `File` key is the exception: it belongs to the project that asked for it,
 * whose DO writes it into that sandbox as a file (and deletes the file when
 * it's removed). No other project sees it, and it changes no egress rules.
 */
import {
  type AccessMessage,
  type Integration,
  IntegrationAccess,
  InvalidRequest,
  type MessageId,
  NotFound,
  type ProjectId,
  sandboxKeyPath,
  UpstreamFailure,
  type UserId
} from "@dream/domain"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Connections, type IntegrationRow, toIntegration } from "../db/Connections.ts"
import { ApiKeyCredential, AppleCredential, GoogleCredential, OAuthCredential } from "../db/Credentials.ts"
import { Projects } from "../db/Projects.ts"
import { Secrets } from "../db/Secrets.ts"
import { randomToken } from "../lib/Ids.ts"
import { importEs256Pem } from "../lib/Jwt.ts"
import { ProjectClients, ProjectDirectory } from "../project/Client.ts"
import { mintAppleJwt } from "./CredentialStore.ts"
import { Google, hostsForScopes, labelForScopes } from "./Google.ts"
import { OAuth, OAuthProviders, placeholderFor } from "./OAuth.ts"

export const GooglePlaceholder = "dream-google-oauth-placeholder"

export const keyPlaceholder = (service: string): string =>
  `dream-${
    service
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "service"
  }-key`

const OAuthStateLifetimeMs = 15 * 60 * 1000

export interface OAuthResult {
  readonly projectId: ProjectId
  readonly messageId: MessageId
}

export class Access extends Context.Service<
  Access,
  {
    readonly startGoogle: (
      userId: UserId,
      projectId: ProjectId,
      messageId: MessageId
    ) => Effect.Effect<string, NotFound | InvalidRequest | UpstreamFailure>
    /** Finishes the Google redirect; fails with a short reason the app can show. */
    readonly finishGoogle: (state: string, code: string) => Effect.Effect<OAuthResult, InvalidRequest | UpstreamFailure>
    readonly startOAuth: (
      userId: UserId,
      projectId: ProjectId,
      messageId: MessageId
    ) => Effect.Effect<string, NotFound | InvalidRequest | UpstreamFailure>
    /** Finishes a provider's redirect; fails with a short reason the app can show. */
    readonly finishOAuth: (
      provider: string,
      state: string,
      code: string
    ) => Effect.Effect<OAuthResult, InvalidRequest | UpstreamFailure>
    readonly submitKey: (
      userId: UserId,
      projectId: ProjectId,
      messageId: MessageId,
      key: string
    ) => Effect.Effect<AccessMessage, NotFound | InvalidRequest | UpstreamFailure>
    readonly submitApple: (
      userId: UserId,
      projectId: ProjectId,
      messageId: MessageId,
      apple: { readonly issuerId: string; readonly keyId: string; readonly privateKey: string }
    ) => Effect.Effect<AccessMessage, NotFound | InvalidRequest | UpstreamFailure>
    readonly decline: (
      userId: UserId,
      projectId: ProjectId,
      messageId: MessageId
    ) => Effect.Effect<AccessMessage, NotFound | InvalidRequest>
    readonly list: (userId: UserId) => Effect.Effect<ReadonlyArray<Integration>>
    /** A new key for a `Key` or `File` integration, from Settings. */
    readonly replaceKey: (
      userId: UserId,
      id: Integration["id"],
      key: string
    ) => Effect.Effect<Integration, NotFound | InvalidRequest>
    readonly disconnect: (userId: UserId, id: Integration["id"]) => Effect.Effect<void, NotFound>
  }
>()("@dream/api/Access") {
  static readonly layer = Layer.effect(
    Access,
    Effect.gen(function* () {
      const connections = yield* Connections
      const secrets = yield* Secrets
      const projects = yield* Projects
      const clients = yield* ProjectClients
      const directory = yield* ProjectDirectory
      const google = yield* Google
      const http = yield* HttpClient.HttpClient
      const providers = yield* OAuthProviders
      const oauth = yield* OAuth

      const owned = (userId: UserId, projectId: ProjectId) =>
        Effect.flatMap(projects.findOwned(userId, projectId), (found) =>
          Option.match(found, {
            onNone: () => Effect.fail(new NotFound({ entity: "project", id: projectId })),
            onSome: Effect.succeed
          })
        )

      /**
       * The access request, and whether it's already connected. Open, declined and disconnected requests can be
       * connected; so can a card still marked connected to an integration that's gone (from before cards were told).
       */
      const accessFor = (userId: UserId, projectId: ProjectId, messageId: MessageId) =>
        Effect.gen(function* () {
          yield* owned(userId, projectId)
          const message = yield* clients.use(projectId, (client) => client.GetAccess({ messageId }))
          const connected =
            message.state._tag === "Connected" &&
            Option.isSome(yield* connections.integration(userId, message.state.integrationId))
          return { message, connected }
        })

      /** For starting a sign-in, which a connected request doesn't need. */
      const openAccess = (userId: UserId, projectId: ProjectId, messageId: MessageId) =>
        Effect.gen(function* () {
          const { message, connected } = yield* accessFor(userId, projectId, messageId)
          if (connected) return yield* new InvalidRequest({ message: "This is connected already." })
          return message
        })

      /**
       * Tells the project, and refreshes every sandbox of theirs (a file key concerns only the project). When the
       * connection had stopped working (`wasFailed`), every project's cards for it are connected again instead.
       */
      const announce = (
        userId: UserId,
        projectId: ProjectId,
        messageId: MessageId,
        row: IntegrationRow,
        wasFailed = false
      ) =>
        Effect.gen(function* () {
          const integration = toIntegration(row)
          const message = yield* clients.use(projectId, (client) => client.AccessConnected({ messageId, integration }))
          if (wasFailed) yield* directory.integrationRestored(userId, integration, projectId)
          if (row.kind !== "sandbox_file") yield* directory.credentialsChanged(userId)
          return message
        })

      const startGoogle = Effect.fn("Access.startGoogle")(function* (
        userId: UserId,
        projectId: ProjectId,
        messageId: MessageId
      ) {
        const message = yield* openAccess(userId, projectId, messageId)
        if (message.request._tag !== "Google") {
          return yield* new InvalidRequest({ message: "This access request isn't for Google." })
        }
        const existing = (yield* connections.integrations(userId)).find((row) => row.kind === "google_oauth")
        const state = randomToken(32)
        yield* connections.putOAuthState({
          state,
          user_id: userId,
          project_id: projectId,
          message_id: messageId,
          scopes_json: message.request.scopes,
          expires_at_ms: (yield* Clock.currentTimeMillis) + OAuthStateLifetimeMs
        })
        const loginHint = existing?.access_json._tag === "Google" ? existing.access_json.email : undefined
        return yield* google.authorizeUrl({ state, scopes: message.request.scopes, loginHint })
      })

      const finishGoogle = Effect.fn("Access.finishGoogle")(function* (state: string, code: string) {
        const now = yield* Clock.currentTimeMillis
        const pending = yield* connections.takeOAuthState(state, now)
        if (Option.isNone(pending)) return yield* new InvalidRequest({ message: "expired" })
        const { user_id: userId, project_id: projectId, message_id: messageId, scopes_json: requested } = pending.value
        const tokens = yield* google.exchangeCode(code)
        if (tokens.refresh_token === undefined) {
          return yield* new UpstreamFailure({ service: "Google", message: "no refresh token" })
        }
        const email = tokens.email
        const existing = (yield* connections.integrations(userId)).find(
          (row) => row.kind === "google_oauth" && row.access_json._tag === "Google" && row.access_json.email === email
        )
        const previousScopes = existing?.access_json._tag === "Google" ? existing.access_json.scopes : []
        const scopes = [...new Set([...previousScopes, ...requested])]
        const access = IntegrationAccess.cases.Google.make({
          ...(email === undefined ? {} : { email }),
          scopes,
          hosts: hostsForScopes(scopes),
          placeholder: GooglePlaceholder
        })
        const credential: GoogleCredential = {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          accessExpiresAtMs: now + tokens.expires_in * 1000,
          scope: tokens.scope ?? ""
        }
        let row: IntegrationRow
        if (existing !== undefined) {
          yield* secrets.replace(existing.secret_id, GoogleCredential, credential)
          yield* connections.updateIntegration(existing.id, {
            status: "connected",
            label: labelForScopes(scopes),
            access,
            accessExpiresAtMs: credential.accessExpiresAtMs
          })
          row = (yield* connections.integration(userId, existing.id)).pipe(Option.getOrThrow)
        } else {
          const secretId = yield* secrets.put(userId, "google_oauth", GoogleCredential, credential)
          row = yield* connections.createIntegration({
            userId,
            kind: "google_oauth",
            label: labelForScopes(scopes),
            access,
            secretId,
            accessExpiresAtMs: credential.accessExpiresAtMs
          })
        }
        yield* announce(userId, projectId, messageId, row, existing?.status === "failed").pipe(
          Effect.catchTag("NotFound", () => Effect.fail(new InvalidRequest({ message: "the request is gone" })))
        )
        return { projectId, messageId }
      })

      /** One file key per project and file name: entering it again replaces the file's contents. */
      const submitFileKey = Effect.fn("Access.submitFileKey")(function* (
        userId: UserId,
        projectId: ProjectId,
        messageId: MessageId,
        request: { readonly service: string; readonly name: string },
        key: string
      ) {
        const access = IntegrationAccess.cases.File.make({
          service: request.service,
          name: request.name,
          path: sandboxKeyPath(request.name),
          projectId
        })
        const credential = { key: key.trim() }
        if (credential.key.length === 0) return yield* new InvalidRequest({ message: "The key is empty." })
        const existing = (yield* connections.integrations(userId)).find(
          (row) =>
            row.kind === "sandbox_file" &&
            row.access_json._tag === "File" &&
            row.access_json.projectId === projectId &&
            row.access_json.name === request.name
        )
        let row: IntegrationRow
        if (existing !== undefined) {
          yield* secrets.replace(existing.secret_id, ApiKeyCredential, credential)
          yield* connections.updateIntegration(existing.id, { status: "connected", label: request.service, access })
          row = (yield* connections.integration(userId, existing.id)).pipe(Option.getOrThrow)
        } else {
          const secretId = yield* secrets.put(userId, "sandbox_file", ApiKeyCredential, credential)
          row = yield* connections.createIntegration({
            userId,
            kind: "sandbox_file",
            label: request.service,
            access,
            secretId
          })
        }
        return yield* announce(userId, projectId, messageId, row)
      })

      const startOAuth = Effect.fn("Access.startOAuth")(function* (
        userId: UserId,
        projectId: ProjectId,
        messageId: MessageId
      ) {
        const message = yield* openAccess(userId, projectId, messageId)
        if (message.request._tag !== "OAuth") {
          return yield* new InvalidRequest({ message: "This access request isn't for an OAuth sign-in." })
        }
        const request = message.request
        const provider = yield* providers.configured(request.provider).pipe(
          Effect.mapError(
            () =>
              new UpstreamFailure({
                service: request.service ?? request.provider,
                message: "sign-in isn't set up on this deployment of Dream yet"
              })
          )
        )
        // Ask again for what they granted before, so reconnecting never narrows what other projects rely on.
        const existing = (yield* connections.integrations(userId)).find(
          (row) =>
            row.kind === "oauth" && row.access_json._tag === "OAuth" && row.access_json.provider === provider.spec.id
        )
        const previous = existing?.access_json._tag === "OAuth" ? existing.access_json.scopes : []
        const scopes = [...new Set([...previous, ...request.scopes])]
        const state = randomToken(32)
        const codeVerifier = provider.spec.pkce === true ? randomToken(64) : undefined
        yield* connections.putProviderState({
          state,
          user_id: userId,
          project_id: projectId,
          message_id: messageId,
          scopes_json: scopes,
          expires_at_ms: (yield* Clock.currentTimeMillis) + OAuthStateLifetimeMs,
          provider: provider.spec.id,
          code_verifier: codeVerifier ?? null
        })
        return yield* oauth.authorizeUrl(provider, { state, scopes, codeVerifier })
      })

      const finishOAuth = Effect.fn("Access.finishOAuth")(function* (providerId: string, state: string, code: string) {
        const now = yield* Clock.currentTimeMillis
        const pending = yield* connections.takeProviderState(providerId, state, now)
        if (Option.isNone(pending)) return yield* new InvalidRequest({ message: "expired" })
        const { user_id: userId, project_id: projectId, message_id: messageId, scopes_json: requested } = pending.value
        const provider = yield* providers
          .configured(providerId)
          .pipe(Effect.mapError(() => new InvalidRequest({ message: "it isn't set up on this deployment" })))
        const { spec } = provider
        const tokens = yield* oauth
          .exchangeCode(provider, code, pending.value.code_verifier ?? undefined)
          .pipe(
            Effect.catchTag("OAuthRejected", (rejected) =>
              Effect.fail(new InvalidRequest({ message: `${spec.service} refused the sign-in (${rejected.reason})` }))
            )
          )
        const account = yield* oauth.account(provider, tokens)
        const access = IntegrationAccess.cases.OAuth.make({
          provider: spec.id,
          service: spec.service,
          ...Option.match(account, { onNone: () => ({}), onSome: (value) => ({ account: value }) }),
          scopes: tokens.scopes ?? requested,
          hosts: spec.hosts.map(({ host }) => host),
          placeholder: placeholderFor(spec.id),
          ...(spec.notes === undefined ? {} : { notes: spec.notes })
        })
        const credential: OAuthCredential = {
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
          ...(tokens.expiresAtMs === undefined ? {} : { accessExpiresAtMs: tokens.expiresAtMs })
        }
        // One connection per provider: each host carries one token, so connecting again replaces it.
        const existing = (yield* connections.integrations(userId)).find(
          (row) => row.kind === "oauth" && row.access_json._tag === "OAuth" && row.access_json.provider === spec.id
        )
        let row: IntegrationRow
        if (existing !== undefined) {
          yield* secrets.replace(existing.secret_id, OAuthCredential, credential)
          yield* connections.updateIntegration(existing.id, {
            status: "connected",
            label: spec.service,
            access,
            accessExpiresAtMs: credential.accessExpiresAtMs ?? null
          })
          row = (yield* connections.integration(userId, existing.id)).pipe(Option.getOrThrow)
        } else {
          const secretId = yield* secrets.put(userId, "oauth_tokens", OAuthCredential, credential)
          row = yield* connections.createIntegration({
            userId,
            kind: "oauth",
            label: spec.service,
            access,
            secretId,
            accessExpiresAtMs: credential.accessExpiresAtMs
          })
        }
        yield* announce(userId, projectId, messageId, row, existing?.status === "failed").pipe(
          Effect.catchTag("NotFound", () => Effect.fail(new InvalidRequest({ message: "the request is gone" })))
        )
        return { projectId, messageId }
      })

      const submitKey = Effect.fn("Access.submitKey")(function* (
        userId: UserId,
        projectId: ProjectId,
        messageId: MessageId,
        key: string
      ) {
        const { message, connected } = yield* accessFor(userId, projectId, messageId)
        // A retry of a submission that went through (its response was lost): nothing more to do.
        if (connected) return message
        if (message.request._tag === "File") {
          return yield* submitFileKey(userId, projectId, messageId, message.request, key)
        }
        if (message.request._tag !== "Key")
          return yield* new InvalidRequest({ message: "This access request isn't for a key." })
        const request = message.request
        const access = IntegrationAccess.cases.Key.make({
          service: request.service,
          host: request.host,
          header: request.header,
          format: request.format,
          placeholder: keyPlaceholder(request.service)
        })
        const existing = (yield* connections.integrations(userId)).find(
          (row) => row.kind === "api_key" && row.access_json._tag === "Key" && row.access_json.host === request.host
        )
        let row: IntegrationRow
        if (existing !== undefined) {
          yield* secrets.replace(existing.secret_id, ApiKeyCredential, { key: key.trim() })
          yield* connections.updateIntegration(existing.id, { status: "connected", label: request.service, access })
          row = (yield* connections.integration(userId, existing.id)).pipe(Option.getOrThrow)
        } else {
          const secretId = yield* secrets.put(userId, "api_key", ApiKeyCredential, { key: key.trim() })
          row = yield* connections.createIntegration({
            userId,
            kind: "api_key",
            label: request.service,
            access,
            secretId
          })
        }
        return yield* announce(userId, projectId, messageId, row)
      })

      const submitApple = Effect.fn("Access.submitApple")(function* (
        userId: UserId,
        projectId: ProjectId,
        messageId: MessageId,
        apple: { readonly issuerId: string; readonly keyId: string; readonly privateKey: string }
      ) {
        const { message, connected } = yield* accessFor(userId, projectId, messageId)
        if (connected) return message
        if (message.request._tag !== "Apple") {
          return yield* new InvalidRequest({ message: "This access request isn't for App Store Connect." })
        }
        yield* importEs256Pem(apple.privateKey).pipe(
          Effect.mapError(() => new InvalidRequest({ message: "That doesn't look like an App Store Connect .p8 key." }))
        )
        const now = yield* Clock.currentTimeMillis
        const base: AppleCredential = {
          issuerId: apple.issuerId.trim(),
          keyId: apple.keyId.trim(),
          privateKey: apple.privateKey
        }
        const minted = yield* mintAppleJwt(base, now).pipe(
          Effect.mapError(() => new InvalidRequest({ message: "That .p8 key couldn't be used to sign." }))
        )
        // Check the key with Apple before keeping it.
        const response = yield* HttpClientRequest.get("https://api.appstoreconnect.apple.com/v1/apps").pipe(
          HttpClientRequest.setUrlParams({ limit: 1 }),
          HttpClientRequest.bearerToken(minted.jwt),
          http.execute,
          Effect.mapError(
            () =>
              new UpstreamFailure({ service: "App Store Connect", message: "couldn't reach Apple to check the key" })
          )
        )
        if (response.status === 401 || response.status === 403) {
          return yield* new InvalidRequest({
            message:
              "Apple didn't accept this key. Check the issuer ID and key ID, and that the key has App Manager access."
          })
        }
        const credential: AppleCredential = { ...base, jwt: minted.jwt, jwtExpiresAtMs: minted.expiresAtMs }
        const access = IntegrationAccess.cases.Apple.make({ issuerId: base.issuerId, keyId: base.keyId })
        const existing = (yield* connections.integrations(userId)).find((row) => row.kind === "apple_asc")
        let row: IntegrationRow
        if (existing !== undefined) {
          yield* secrets.replace(existing.secret_id, AppleCredential, credential)
          yield* connections.updateIntegration(existing.id, {
            status: "connected",
            access,
            accessExpiresAtMs: minted.expiresAtMs
          })
          row = (yield* connections.integration(userId, existing.id)).pipe(Option.getOrThrow)
        } else {
          const secretId = yield* secrets.put(userId, "apple_asc", AppleCredential, credential)
          row = yield* connections.createIntegration({
            userId,
            kind: "apple_asc",
            label: "Apple Developer",
            access,
            secretId,
            accessExpiresAtMs: minted.expiresAtMs
          })
        }
        return yield* announce(userId, projectId, messageId, row)
      })

      const decline = (userId: UserId, projectId: ProjectId, messageId: MessageId) =>
        Effect.gen(function* () {
          yield* owned(userId, projectId)
          return yield* clients.use(projectId, (client) => client.DeclineAccess({ messageId }))
        })

      const list = (userId: UserId) => Effect.map(connections.integrations(userId), (rows) => rows.map(toIntegration))

      const replaceKey = Effect.fn("Access.replaceKey")(function* (userId: UserId, id: Integration["id"], key: string) {
        const found = yield* connections.integration(userId, id)
        if (Option.isNone(found)) return yield* new NotFound({ entity: "integration", id })
        const row = found.value
        if (row.kind !== "api_key" && row.kind !== "sandbox_file") {
          return yield* new InvalidRequest({ message: `${row.label} isn't a key; connect it again from a project.` })
        }
        const credential = { key: key.trim() }
        if (credential.key.length === 0) return yield* new InvalidRequest({ message: "The key is empty." })
        const integration = toIntegration(row)
        // The same key again (a retry after a lost response) changes nothing, and the agent doesn't hear twice.
        if ((yield* secrets.get(row.secret_id, ApiKeyCredential)).key === credential.key) return integration
        yield* secrets.replace(row.secret_id, ApiKeyCredential, credential)
        if (row.access_json._tag === "File") {
          // Its project rewrites the file before the agent hears. An archived project has no sandbox to write to.
          yield* clients
            .use(row.access_json.projectId, (client) => client.KeyFileReplaced({ integration }))
            .pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't tell the project its key changed", cause)))
        } else {
          yield* directory.credentialsChanged(userId)
        }
        return integration
      })

      const disconnect = Effect.fn("Access.disconnect")(function* (userId: UserId, id: Integration["id"]) {
        const row = yield* connections.integration(userId, id)
        if (Option.isNone(row)) return yield* new NotFound({ entity: "integration", id })
        if (row.value.kind === "google_oauth") {
          const credential = yield* secrets.get(row.value.secret_id, GoogleCredential)
          yield* google.revoke(credential.refreshToken)
        }
        if (row.value.kind === "oauth" && row.value.access_json._tag === "OAuth") {
          const credential = yield* secrets.get(row.value.secret_id, OAuthCredential)
          const provider = yield* providers.configured(row.value.access_json.provider).pipe(Effect.option)
          if (Option.isSome(provider)) yield* oauth.revoke(provider.value, credential.accessToken)
        }
        yield* connections.deleteIntegration(id)
        yield* secrets.remove(row.value.secret_id)
        const access = row.value.access_json
        const integration = toIntegration(row.value)
        if (access._tag === "File") {
          // Its project deletes the file and tells the agent. An archived project's sandbox is already gone.
          yield* clients
            .use(access.projectId, (client) => client.IntegrationGone({ integration }))
            .pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't tell the project a key file went", cause)))
        } else {
          // Every sandbox drops its rules; the projects that asked for it mark their cards and tell their agents.
          yield* directory.integrationGone(userId, integration)
        }
      })

      return Access.of({
        startGoogle,
        finishGoogle,
        startOAuth,
        finishOAuth,
        submitKey,
        submitApple,
        decline,
        list,
        replaceKey,
        disconnect
      })
    })
  )
}
