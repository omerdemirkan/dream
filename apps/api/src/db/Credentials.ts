/**
 * What the `secrets` table holds for each kind of credential. These never
 * leave the Worker: they become E2B egress-rule header values, or are sent to
 * the provider that issued them (refreshes).
 */
import { Schema } from "effect"

export const ClaudeCredential = Schema.Struct({
  /** Long-lived OAuth token from `claude setup-token` (sk-ant-oat01-…). */
  token: Schema.String
})
export type ClaudeCredential = typeof ClaudeCredential.Type

export const ChatGptCredential = Schema.Struct({
  idToken: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  accountId: Schema.optionalKey(Schema.String),
  /** Epoch ms when `accessToken` expires (its JWT `exp`). */
  accessExpiresAtMs: Schema.optionalKey(Schema.Number)
})
export type ChatGptCredential = typeof ChatGptCredential.Type

export const GoogleCredential = Schema.Struct({
  refreshToken: Schema.String,
  accessToken: Schema.String,
  accessExpiresAtMs: Schema.Number,
  /** Space-separated scopes Google granted. */
  scope: Schema.String
})
export type GoogleCredential = typeof GoogleCredential.Type

export const ApiKeyCredential = Schema.Struct({ key: Schema.String })
export type ApiKeyCredential = typeof ApiKeyCredential.Type

export const AppleCredential = Schema.Struct({
  issuerId: Schema.String,
  keyId: Schema.String,
  /** The .p8 contents (PKCS#8 PEM). */
  privateKey: Schema.String,
  /** The current App Store Connect JWT injected for api.appstoreconnect.apple.com, and when it expires. */
  jwt: Schema.optionalKey(Schema.String),
  jwtExpiresAtMs: Schema.optionalKey(Schema.Number)
})
export type AppleCredential = typeof AppleCredential.Type

/** Tokens from an OAuth provider other than Google (`src/integrations/OAuth.ts`). */
export const OAuthCredential = Schema.Struct({
  accessToken: Schema.String,
  /** Absent for providers whose tokens don't expire (GitHub OAuth apps, Notion). */
  refreshToken: Schema.optionalKey(Schema.String),
  /** Epoch ms when `accessToken` expires; absent if it doesn't. */
  accessExpiresAtMs: Schema.optionalKey(Schema.Number)
})
export type OAuthCredential = typeof OAuthCredential.Type

/** Access to a short-lived sign-in sandbox, kept while a model connection is pending. */
export const AuthSandboxSession = Schema.Struct({
  sandboxId: Schema.String,
  domain: Schema.String,
  envdAccessToken: Schema.String,
  pid: Schema.Number
})
export type AuthSandboxSession = typeof AuthSandboxSession.Type
