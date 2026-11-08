/**
 * Dream's own bearer tokens, all HS256 with the signing key:
 * - session: the phone's sign-in (AppAuth)
 * - project: dreamd's project-scoped token (SandboxAuth), in DREAM_PROJECT_TOKEN
 * - live: the short-lived WebSocket ticket from GetLiveUrl
 * - upload: a one-media-file PUT to the Worker
 * - attachment: the PUT of one photo or file they attach
 * - connect: a `CreateConnectLink` page (single use, recorded in D1 by `jti`)
 * - openai: a project's credential for Dream's OpenAI gateway, which only egress adds (`OpenAIGateway`)
 */
import { ConnectLinkProvider, MediaContentType, MediaId, ProjectId, UserId } from "@dream/domain"
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

const AttachmentUploadClaims = Schema.Struct({
  iss: Schema.Literal(issuer),
  typ: Schema.Literal("attachment"),
  sub: UserId,
  aid: MediaId,
  ct: Schema.String,
  size: Schema.Int,
  exp: Schema.Number
})
export type AttachmentUploadClaims = typeof AttachmentUploadClaims.Type

const ConnectClaims = Schema.Struct({
  iss: Schema.Literal(issuer),
  typ: Schema.Literal("connect"),
  sub: UserId,
  prv: ConnectLinkProvider,
  jti: Schema.String,
  exp: Schema.Number
})
/**
 * No `iat` or `exp`: the same project always gets the same credential, so the egress rules that carry it hash the
 * same and aren't pushed again. Deleting the project revokes it (the gateway looks the project up).
 */
const OpenAIGatewayClaims = Schema.Struct({
  iss: Schema.Literal(issuer),
  typ: Schema.Literal("openai"),
  sub: UserId,
  pid: ProjectId
})

/**
 * A gateway credential for a dev pseudo-project (`prj_dev_<label>`, owned by `dream`): for checks against the live
 * Worker that must not run an agent. Minted only by the operator's route, and good for an hour.
 */
const OpenAIDevClaims = Schema.Struct({
  iss: Schema.Literal(issuer),
  typ: Schema.Literal("openai-dev"),
  sub: UserId,
  pid: ProjectId,
  exp: Schema.Number
})

/** The dev pseudo-projects' ids, and who they belong to. */
export const DevProjectPrefix = "prj_dev_"
export const DevCredentialLifetime = Duration.hours(1)

export interface GatewayCaller {
  readonly projectId: ProjectId
  readonly userId: UserId
  /** A dev pseudo-project: no D1 row, metered to Dream. */
  readonly dev: boolean
}

export interface ConnectTicket {
  readonly userId: UserId
  readonly provider: ConnectLinkProvider
  readonly ticketId: string
  readonly expiresAtMs: number
}

export const SessionLifetime = Duration.days(90)
export const LiveTicketLifetime = Duration.seconds(60)
export const UploadLifetime = Duration.minutes(15)
export const ConnectTicketLifetime = Duration.minutes(15)

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
    readonly attachmentUpload: (
      claims: Omit<AttachmentUploadClaims, "iss" | "typ" | "exp">
    ) => Effect.Effect<{ readonly token: string; readonly expiresAtMs: number }>
    readonly verifyAttachmentUpload: (token: string) => Effect.Effect<AttachmentUploadClaims, InvalidToken>
    readonly connectTicket: (
      claims: Omit<ConnectTicket, "expiresAtMs">
    ) => Effect.Effect<{ readonly token: string; readonly expiresAtMs: number }>
    readonly verifyConnectTicket: (token: string) => Effect.Effect<ConnectTicket, InvalidToken>
    readonly openaiGateway: (projectId: ProjectId, userId: UserId) => Effect.Effect<Redacted.Redacted<string>>
    readonly verifyOpenAIGateway: (token: string) => Effect.Effect<GatewayCaller, InvalidToken>
    /** A dev pseudo-project's credential (`label`: lowercase letters, digits and dashes). */
    readonly openaiDevGateway: (
      label: string,
      owner: UserId
    ) => Effect.Effect<{
      readonly token: Redacted.Redacted<string>
      readonly projectId: ProjectId
      readonly expiresAtMs: number
    }>
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
        attachmentUpload: (claims) =>
          Effect.gen(function* () {
            const exp = (yield* nowSeconds) + Duration.toSeconds(UploadLifetime)
            const token = yield* signHs256(key, { iss: issuer, typ: "attachment", ...claims, exp })
            return { token, expiresAtMs: exp * 1000 }
          }),
        verifyAttachmentUpload: (token) => verify(token, AttachmentUploadClaims).pipe(Effect.flatMap(notExpired)),
        connectTicket: ({ userId, provider, ticketId }) =>
          Effect.gen(function* () {
            const exp = (yield* nowSeconds) + Duration.toSeconds(ConnectTicketLifetime)
            const token = yield* signHs256(key, {
              iss: issuer,
              typ: "connect",
              sub: userId,
              prv: provider,
              jti: ticketId,
              exp
            })
            return { token, expiresAtMs: exp * 1000 }
          }),
        verifyConnectTicket: (token) =>
          verify(token, ConnectClaims).pipe(
            Effect.flatMap(notExpired),
            Effect.map((claims) => ({
              userId: claims.sub,
              provider: claims.prv,
              ticketId: claims.jti,
              expiresAtMs: claims.exp * 1000
            }))
          ),
        openaiGateway: (projectId, userId) =>
          Effect.map(signHs256(key, { iss: issuer, typ: "openai", sub: userId, pid: projectId }), Redacted.make),
        verifyOpenAIGateway: (token) =>
          verify(token, OpenAIGatewayClaims).pipe(
            Effect.map((claims): GatewayCaller => ({ projectId: claims.pid, userId: claims.sub, dev: false })),
            Effect.catch(() =>
              verify(token, OpenAIDevClaims).pipe(
                Effect.flatMap(notExpired),
                Effect.flatMap((claims) =>
                  claims.pid.startsWith(DevProjectPrefix)
                    ? Effect.succeed<GatewayCaller>({ projectId: claims.pid, userId: claims.sub, dev: true })
                    : Effect.fail(new InvalidToken({ reason: "not a dev project" }))
                )
              )
            )
          ),
        openaiDevGateway: (label, owner) =>
          Effect.gen(function* () {
            const exp = (yield* nowSeconds) + Duration.toSeconds(DevCredentialLifetime)
            const projectId = `${DevProjectPrefix}${label}` as ProjectId
            const token = yield* signHs256(key, { iss: issuer, typ: "openai-dev", sub: owner, pid: projectId, exp })
            return { token: Redacted.make(token), projectId, expiresAtMs: exp * 1000 }
          })
      })
    })
  )
}
