/**
 * Current header values for a person's credentials, refreshed centrally.
 * ChatGPT access tokens (refresh tokens rotate on each use), Google access
 * tokens (1 h) and App Store Connect JWTs (20 min max) all expire, so before
 * one goes into a sandbox's egress rules it is refreshed here, under a D1 lock
 * so two isolates never spend the same refresh token.
 */
import { UpstreamFailure, type UserId } from "@dream/domain"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { ChatGpt } from "../connect/ChatGpt.ts"
import { Connections, type IntegrationRow, type ModelConnectionRow } from "../db/Connections.ts"
import {
  ApiKeyCredential,
  AppleCredential,
  ChatGptCredential,
  ClaudeCredential,
  GoogleCredential
} from "../db/Credentials.ts"
import { Secrets } from "../db/Secrets.ts"
import { importEs256Pem, signEs256 } from "../lib/Jwt.ts"
import { Google } from "./Google.ts"

/** Refresh when less than this is left. */
export const RefreshMarginMs = 10 * 60 * 1000
const LockMs = 60 * 1000
const AppleJwtLifetimeS = 19 * 60

export const mintAppleJwt = (credential: AppleCredential, nowMs: number) =>
  Effect.gen(function* () {
    const key = yield* importEs256Pem(credential.privateKey)
    const iat = Math.floor(nowMs / 1000)
    const exp = iat + AppleJwtLifetimeS
    const jwt = yield* signEs256(
      key,
      { kid: credential.keyId, typ: "JWT" },
      { iss: credential.issuerId, iat, exp, aud: "appstoreconnect-v1" }
    )
    return { jwt, expiresAtMs: exp * 1000 }
  })

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly claude: (row: ModelConnectionRow) => Effect.Effect<ClaudeCredential>
    /** The ChatGPT tokens, refreshed if they expire soon (or `force`). */
    readonly chatGpt: (row: ModelConnectionRow, force?: boolean) => Effect.Effect<ChatGptCredential, UpstreamFailure>
    readonly google: (row: IntegrationRow, force?: boolean) => Effect.Effect<GoogleCredential, UpstreamFailure>
    readonly apiKey: (row: IntegrationRow) => Effect.Effect<ApiKeyCredential>
    /** The credential with a current App Store Connect JWT. */
    readonly apple: (row: IntegrationRow) => Effect.Effect<AppleCredential, UpstreamFailure>
    /** Refreshes everything that expires within the margin; returns whose credentials changed. */
    readonly sweep: Effect.Effect<ReadonlyArray<UserId>>
  }
>()("@dream/api/CredentialStore") {
  static readonly layer = Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const connections = yield* Connections
      const secrets = yield* Secrets
      const chatGptClient = yield* ChatGpt
      const google = yield* Google

      const withLock = <A, E>(
        lock: (nowMs: number, untilMs: number) => Effect.Effect<boolean>,
        unlock: Effect.Effect<void>,
        refresh: Effect.Effect<A, E>,
        reread: Effect.Effect<A, E>
      ) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          if (yield* lock(now, now + LockMs)) return yield* refresh.pipe(Effect.ensuring(unlock))
          // Someone else is refreshing: give them a moment, then use what they stored.
          yield* Effect.sleep("2 seconds")
          return yield* reread
        })

      const claude = (row: ModelConnectionRow) =>
        row.secret_id === null
          ? Effect.die("claude connection has no secret")
          : secrets.get(row.secret_id, ClaudeCredential)

      const chatGpt = Effect.fn("CredentialStore.chatGpt")(function* (row: ModelConnectionRow, force = false) {
        if (row.secret_id === null) return yield* Effect.die("chatgpt connection has no secret")
        const secretId = row.secret_id
        const current = yield* secrets.get(secretId, ChatGptCredential)
        const now = yield* Clock.currentTimeMillis
        if (!force && (current.accessExpiresAtMs === undefined || current.accessExpiresAtMs > now + RefreshMarginMs)) {
          return current
        }
        return yield* withLock(
          (nowMs, untilMs) => connections.lockModelRefresh(row.id, nowMs, untilMs),
          connections.unlockModelRefresh(row.id),
          Effect.gen(function* () {
            // Re-read under the lock: another refresh may have just finished.
            const latest = yield* secrets.get(secretId, ChatGptCredential)
            if (!force && latest.accessExpiresAtMs !== undefined && latest.accessExpiresAtMs > now + RefreshMarginMs) {
              return latest
            }
            const fresh = yield* chatGptClient
              .refresh(latest)
              .pipe(
                Effect.tapError(() =>
                  connections.updateModelConnection(row.id, { status: "expired", error: "The ChatGPT sign-in expired" })
                )
              )
            yield* secrets.replace(secretId, ChatGptCredential, fresh)
            yield* connections.updateModelConnection(row.id, { accessExpiresAtMs: fresh.accessExpiresAtMs ?? null })
            return fresh
          }),
          secrets.get(secretId, ChatGptCredential)
        )
      })

      const googleCredential = Effect.fn("CredentialStore.google")(function* (row: IntegrationRow, force = false) {
        const current = yield* secrets.get(row.secret_id, GoogleCredential)
        const now = yield* Clock.currentTimeMillis
        if (!force && current.accessExpiresAtMs > now + RefreshMarginMs) return current
        return yield* withLock(
          (nowMs, untilMs) => connections.lockIntegrationRefresh(row.id, nowMs, untilMs),
          connections.unlockIntegrationRefresh(row.id),
          Effect.gen(function* () {
            const latest = yield* secrets.get(row.secret_id, GoogleCredential)
            if (!force && latest.accessExpiresAtMs > now + RefreshMarginMs) return latest
            const tokens = yield* google
              .refresh(latest.refreshToken)
              .pipe(Effect.tapError(() => connections.updateIntegration(row.id, { status: "failed" })))
            const fresh: GoogleCredential = {
              refreshToken: tokens.refresh_token ?? latest.refreshToken,
              accessToken: tokens.access_token,
              accessExpiresAtMs: now + tokens.expires_in * 1000,
              scope: tokens.scope ?? latest.scope
            }
            yield* secrets.replace(row.secret_id, GoogleCredential, fresh)
            yield* connections.updateIntegration(row.id, { accessExpiresAtMs: fresh.accessExpiresAtMs })
            return fresh
          }),
          secrets.get(row.secret_id, GoogleCredential)
        )
      })

      const apiKey = (row: IntegrationRow) => secrets.get(row.secret_id, ApiKeyCredential)

      const apple = Effect.fn("CredentialStore.apple")(function* (row: IntegrationRow) {
        const current = yield* secrets.get(row.secret_id, AppleCredential)
        const now = yield* Clock.currentTimeMillis
        if (
          current.jwt !== undefined &&
          current.jwtExpiresAtMs !== undefined &&
          current.jwtExpiresAtMs > now + 5 * 60 * 1000
        ) {
          return current
        }
        const minted = yield* mintAppleJwt(current, now).pipe(
          Effect.mapError(
            () => new UpstreamFailure({ service: "App Store Connect", message: "the .p8 key couldn't be read" })
          )
        )
        const fresh: AppleCredential = { ...current, jwt: minted.jwt, jwtExpiresAtMs: minted.expiresAtMs }
        yield* secrets.replace(row.secret_id, AppleCredential, fresh)
        yield* connections.updateIntegration(row.id, { accessExpiresAtMs: minted.expiresAtMs })
        return fresh
      })

      const sweep = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const changed = new Set<UserId>()
        for (const row of yield* connections.expiringChatGpt(now + RefreshMarginMs)) {
          const refreshed = yield* chatGpt(row).pipe(Effect.option)
          if (Option.isSome(refreshed)) changed.add(row.user_id)
        }
        for (const row of yield* connections.expiringIntegrations(now + RefreshMarginMs)) {
          const refreshed =
            row.kind === "google_oauth"
              ? yield* googleCredential(row).pipe(Effect.asVoid, Effect.option)
              : row.kind === "apple_asc"
                ? yield* apple(row).pipe(Effect.asVoid, Effect.option)
                : Option.none()
          if (Option.isSome(refreshed)) changed.add(row.user_id)
        }
        return [...changed]
      }).pipe(Effect.withSpan("CredentialStore.sweep"))

      return CredentialStore.of({ claude, chatGpt, google: googleCredential, apiKey, apple, sweep })
    })
  )
}
