/**
 * Dream's own bearer tokens, all HS256 with the signing key:
 * - session: the phone's sign-in (AppAuth)
 * - project: dreamd's project-scoped token (SandboxAuth), in DREAM_PROJECT_TOKEN
 * - live: the short-lived WebSocket ticket from GetLiveUrl
 * - upload: a one-media-file PUT to the Worker
 * - codex: the placeholder refresh token Codex sends to Dream's refresh endpoint
 */
import { MediaContentType, MediaId, ProjectId, UserId } from "@dream/domain"
import { Clock, Context, Data, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { ApiConfig } from "../Config.ts"
import { utf8 } from "../lib/Bytes.ts"
import { importHmacKey, signHs256, verifyHs256 } from "../lib/Jwt.ts"

export class InvalidToken extends Data.TaggedError("InvalidToken")<{ readonly reason: string }> {}

const issuer = "dream"

const SessionClaims = Schema.Struct({
  iss: Schema.Literal(issuer),
  typ: Schema.Literal("session"),
  sub: UserId,
  email: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number
})

const ProjectClaims = Schema.Struct({
  iss: Schema.Literal(issuer),
  typ: Schema.Literal("project"),
  sub: UserId,
  pid: ProjectId,
  iat: Schema.Number
})

const LiveClaims = Schema.Struct({
  iss: Schema.Literal(issuer),
  typ: Schema.Literal("live"),
  sub: UserId,
  pid: ProjectId,
  exp: Schema.Number
})

const UploadClaims = Schema.Struct({
  iss: Schema.Literal(issuer),
  typ: Schema.Literal("upload"),
  mid: MediaId,
  pid: ProjectId,
  ct: MediaContentType,
  size: Schema.Int,
  exp: Schema.Number
})
export type UploadClaims = typeof UploadClaims.Type

const CodexClaims = Schema.Struct({
  iss: Schema.Literal(issuer),
  typ: Schema.Literal("codex"),
  sub: UserId,
  pid: ProjectId
})

export const SessionLifetime = Duration.days(90)
export const LiveTicketLifetime = Duration.seconds(60)
export const UploadLifetime = Duration.minutes(15)

const nowSeconds = Effect.map(Clock.currentTimeMillis, (ms) => Math.floor(ms / 1000))

export class Tokens extends Context.Service<
  Tokens,
  {
    readonly session: (user: {
      readonly id: UserId
      readonly email: string
    }) => Effect.Effect<Redacted.Redacted<string>>
    readonly verifySession: (
      token: string
    ) => Effect.Effect<{ readonly userId: UserId; readonly email: string }, InvalidToken>
    readonly project: (projectId: ProjectId, userId: UserId) => Effect.Effect<Redacted.Redacted<string>>
    readonly verifyProject: (
      token: string
    ) => Effect.Effect<{ readonly projectId: ProjectId; readonly userId: UserId }, InvalidToken>
    readonly liveTicket: (projectId: ProjectId, userId: UserId) => Effect.Effect<string>
    readonly verifyLiveTicket: (
      token: string
    ) => Effect.Effect<{ readonly projectId: ProjectId; readonly userId: UserId }, InvalidToken>
    readonly upload: (
      claims: Omit<UploadClaims, "iss" | "typ" | "exp">
    ) => Effect.Effect<{ readonly token: string; readonly expiresAtMs: number }>
    readonly verifyUpload: (token: string) => Effect.Effect<UploadClaims, InvalidToken>
    readonly codexRefresh: (projectId: ProjectId, userId: UserId) => Effect.Effect<string>
    readonly verifyCodexRefresh: (
      token: string
    ) => Effect.Effect<{ readonly projectId: ProjectId; readonly userId: UserId }, InvalidToken>
  }
>()("@dream/api/Tokens") {
  static readonly layer = Layer.effect(
    Tokens,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const key = yield* importHmacKey(utf8(Redacted.value(config.signingKey)))

      const verify = <S extends Schema.Codec<any, any, never, never>>(token: string, schema: S) =>
        verifyHs256(key, token, schema).pipe(Effect.mapError((error) => new InvalidToken({ reason: error.reason })))

      const notExpired = <C extends { readonly exp: number }>(claims: C) =>
        Effect.flatMap(nowSeconds, (now) =>
          claims.exp > now ? Effect.succeed(claims) : Effect.fail(new InvalidToken({ reason: "expired" }))
        )

      return Tokens.of({
        session: (user) =>
          Effect.gen(function* () {
            const iat = yield* nowSeconds
            const exp = iat + Duration.toSeconds(SessionLifetime)
            return Redacted.make(
              yield* signHs256(key, { iss: issuer, typ: "session", sub: user.id, email: user.email, iat, exp })
            )
          }),
        verifySession: (token) =>
          verify(token, SessionClaims).pipe(
            Effect.flatMap(notExpired),
            Effect.map((claims) => ({ userId: claims.sub, email: claims.email }))
          ),
        project: (projectId, userId) =>
          Effect.gen(function* () {
            const iat = yield* nowSeconds
            return Redacted.make(
              yield* signHs256(key, { iss: issuer, typ: "project", sub: userId, pid: projectId, iat })
            )
          }),
        verifyProject: (token) =>
          verify(token, ProjectClaims).pipe(Effect.map((claims) => ({ projectId: claims.pid, userId: claims.sub }))),
        liveTicket: (projectId, userId) =>
          Effect.gen(function* () {
            const exp = (yield* nowSeconds) + Duration.toSeconds(LiveTicketLifetime)
            return yield* signHs256(key, { iss: issuer, typ: "live", sub: userId, pid: projectId, exp })
          }),
        verifyLiveTicket: (token) =>
          verify(token, LiveClaims).pipe(
            Effect.flatMap(notExpired),
            Effect.map((claims) => ({ projectId: claims.pid, userId: claims.sub }))
          ),
        upload: (claims) =>
          Effect.gen(function* () {
            const exp = (yield* nowSeconds) + Duration.toSeconds(UploadLifetime)
            const token = yield* signHs256(key, { iss: issuer, typ: "upload", ...claims, exp })
            return { token, expiresAtMs: exp * 1000 }
          }),
        verifyUpload: (token) => verify(token, UploadClaims).pipe(Effect.flatMap(notExpired)),
        codexRefresh: (projectId, userId) => signHs256(key, { iss: issuer, typ: "codex", sub: userId, pid: projectId }),
        verifyCodexRefresh: (token) =>
          verify(token, CodexClaims).pipe(Effect.map((claims) => ({ projectId: claims.pid, userId: claims.sub })))
      })
    })
  )
}
