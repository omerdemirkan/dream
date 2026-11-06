/**
 * Over-the-air updates of the iPhone app: `expo-updates` in the app, the Expo Updates protocol (v1) served by the
 * Worker, bundles and assets in R2 (`apps/api/src/http/Updates.ts`). The operator publishes with
 * `apps/mobile/scripts/updates.ts`, which speaks the shapes below to the Worker's admin routes with the
 * `UpdatesSecretHeader`.
 *
 * - An update reaches only builds with its `runtimeVersion` (a fingerprint of the native project, computed the same
 *   way at build and at publish) on its `channel` (the `expo-channel-name` header the build sends).
 * - The Worker signs every manifest and directive with a key it generated itself and keeps sealed; the app embeds
 *   the matching certificate and refuses anything unsigned or signed by another key.
 * - Publishing appends a release; the newest release for a runtime version is what's live. A rollback appends a
 *   copy of an earlier update (new id, new `createdAt`, since clients only move forward in time) or a
 *   `RollBackToEmbedded` release.
 */
import { Schema } from "effect"

/** The header carrying `UPDATES_PUBLISH_SECRET` on the admin routes. */
export const UpdatesSecretHeader = "x-dream-updates-secret"

/** The `keyid` and algorithm of the signing key (the app's `codeSigningMetadata`). */
export const UpdatesKeyId = "main"
export const UpdatesSigningAlgorithm = "rsa-v1_5-sha256"

/**
 * Which builds an update is for, set at build time (`DREAM_UPDATES_CHANNEL`): `production` (TestFlight), `development`
 * (other builds against the live API), `fixtures` (the in-app sample world), or another name for a test.
 */
export const UpdateChannel = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/))
export type UpdateChannel = typeof UpdateChannel.Type

export const UpdatePlatform = Schema.Literals(["ios"])
export type UpdatePlatform = typeof UpdatePlatform.Type

/** A runtime version: the fingerprint hash, or any other build-time string without spaces. */
export const RuntimeVersion = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/))
export type RuntimeVersion = typeof RuntimeVersion.Type

/** Base64url (no padding) SHA-256 of an asset's bytes: the protocol's `hash`, and the asset's address. */
export const AssetHash = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/))
export type AssetHash = typeof AssetHash.Type

/** An update's id: the manifest `id`, a UUID. */
export const UpdateId = Schema.String.check(Schema.isUUID())
export type UpdateId = typeof UpdateId.Type

/** A file of an update, as `expo export` produced it. */
export const UpdateAsset = Schema.Struct({
  hash: AssetHash,
  /** What the bundle refers to it by (the MD5 hex Metro names exported assets with). */
  key: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/)),
  contentType: Schema.String.check(Schema.isPattern(/^[a-z]+\/[A-Za-z0-9.+-]+$/)),
  /** With the leading dot, e.g. ".png". Ignored for the launch asset. */
  fileExtension: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\.[A-Za-z0-9]{1,16}$/)))
})
export type UpdateAsset = typeof UpdateAsset.Type

/** POST `Routes.updatesPublish`, JSON: a new update made of assets already uploaded. */
export const PublishUpdateRequest = Schema.Struct({
  channel: UpdateChannel,
  platform: UpdatePlatform,
  runtimeVersion: RuntimeVersion,
  launchAsset: UpdateAsset,
  assets: Schema.Array(UpdateAsset),
  /** The public app config the update runs with (`expo config --type public`), served as `extra.expoClient`. */
  expoClient: Schema.Record(Schema.String, Schema.Unknown),
  /** The commit it was exported from. */
  gitCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/)),
  message: Schema.String.check(Schema.isMaxLength(500)),
  /** Publish even though no build on this channel has asked for updates with this runtime version yet. */
  force: Schema.optionalKey(Schema.Boolean)
})
export type PublishUpdateRequest = typeof PublishUpdateRequest.Type

/** POST `Routes.updatesRollback`, JSON. */
export const RollbackUpdateRequest = Schema.Struct({
  channel: UpdateChannel,
  platform: UpdatePlatform,
  runtimeVersion: RuntimeVersion,
  /**
   * The update to make live again, or "embedded" for the build's own bundle. Absent: the update published before
   * the one live now (or "embedded" if there's none).
   */
  to: Schema.optionalKey(Schema.Union([UpdateId, Schema.Literal("embedded")]))
})
export type RollbackUpdateRequest = typeof RollbackUpdateRequest.Type

/** One entry of a runtime version's history; the newest is live. */
export const UpdateRelease = Schema.TaggedUnion({
  Update: {
    id: UpdateId,
    createdAt: Schema.DateTimeUtc,
    gitCommit: Schema.String,
    message: Schema.String,
    /** Set when this republishes an earlier update (a rollback or promotion): the update first published. */
    republishOf: Schema.optionalKey(UpdateId)
  },
  RollBackToEmbedded: {
    id: UpdateId,
    createdAt: Schema.DateTimeUtc
  }
})
export type UpdateRelease = typeof UpdateRelease.Type

/** What builds of one runtime version last reported when they asked for an update. */
export const UpdateCheckIn = Schema.Struct({
  lastCheckAt: Schema.DateTimeUtc,
  /** The update the asking build was running (absent: its embedded bundle). */
  runningUpdateId: Schema.optionalKey(Schema.String),
  /** The id of the bundle embedded in that build. */
  embeddedUpdateId: Schema.optionalKey(Schema.String)
})
export type UpdateCheckIn = typeof UpdateCheckIn.Type

export const RuntimeUpdates = Schema.Struct({
  runtimeVersion: RuntimeVersion,
  platform: UpdatePlatform,
  /** Newest first; the first is live. */
  releases: Schema.Array(UpdateRelease),
  checkIn: Schema.optionalKey(UpdateCheckIn)
})
export type RuntimeUpdates = typeof RuntimeUpdates.Type

/** GET `Routes.updatesStatus?channel=…`: every runtime version with releases or check-ins on the channel. */
export const UpdatesStatus = Schema.Struct({
  channel: UpdateChannel,
  runtimes: Schema.Array(RuntimeUpdates)
})
export type UpdatesStatus = typeof UpdatesStatus.Type

/** The signing certificate (`Routes.updatesCertificate`, and `Routes.updatesSigningKey`'s response). */
export const UpdatesCertificate = Schema.Struct({
  /** PEM, X.509, self-signed, code signing. What the app embeds. */
  certificatePem: Schema.String,
  /** Whether this request created the key (false: it existed). */
  created: Schema.Boolean
})
export type UpdatesCertificate = typeof UpdatesCertificate.Type
