/**
 * What the Worker runs on per invocation, and its scheduled maintenance.
 * Kept apart from Api.ts (which needs workerd) so tests can build it.
 */
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"
import { Effect, Layer } from "effect"
import { ConnectLinks } from "./connect/ConnectLinks.ts"
import { ModelConnect } from "./connect/ModelConnect.ts"
import { DesktopAccess } from "./desktop/DesktopAccess.ts"
import { Mailer, type SendEmailBinding } from "./email/Mailer.ts"
import { SandboxReaper } from "./e2b/Reaper.ts"
import { MediaStore } from "./http/Media.ts"
import { E2BMetering } from "./metering/E2BMetering.ts"
import { SandboxWakes } from "./db/SandboxWakes.ts"
import { SandboxUsage } from "./metering/SandboxUsage.ts"
import { StorageMeter } from "./metering/Storage.ts"
import { LiveForwarder } from "./http/Router.ts"
import { UpdateAssets } from "./http/Updates.ts"
import { Access } from "./integrations/Access.ts"
import { CredentialStore } from "./integrations/CredentialStore.ts"
import { AppLinks } from "./links/AppLinks.ts"
import { type PlatformOverrides, platformLayer } from "./Platform.ts"
import { type ProjectFetch, ProjectDirectory } from "./project/Client.ts"
import { noRelays } from "./relay/RelayClients.ts"
import { ClientSecrets } from "./openai/ClientSecrets.ts"
import { sweepBackgroundResponses } from "./openai/Gateway.ts"
import { AfterResponse, CallSideband, OpenAIUpstream } from "./openai/Runtime.ts"

export interface WorkerBindings {
  readonly d1: D1Database
  readonly r2: R2Bucket | undefined
  /** The over-the-air updates bucket (`Resources.Updates`). */
  readonly updates: R2Bucket | undefined
  readonly fetchProject: ProjectFetch
  readonly forwardLive: LiveForwarder["Service"]["forward"]
  /** Cloudflare Email Service, once the deployment sends email. */
  readonly email?: SendEmailBinding | undefined
  /** Work after the response (workerd's `waitUntil`); forked when absent. */
  readonly afterResponse?: AfterResponse["Service"]["run"] | undefined
  /** Starts a WebRTC call's sideband (`OpenAICallDO`). */
  readonly attachSideband?: CallSideband["Service"]["attach"] | undefined
}

/** Dream's OpenAI gateway's services (`openai/`); its platform parts can be replaced in tests. */
const openaiLayer = (bindings: WorkerBindings, overrides: PlatformOverrides) =>
  Layer.mergeAll(
    ClientSecrets.layer,
    overrides.openaiUpstream ?? OpenAIUpstream.layer,
    bindings.afterResponse === undefined
      ? AfterResponse.layerFork
      : Layer.succeed(AfterResponse, AfterResponse.of({ run: bindings.afterResponse })),
    bindings.attachSideband === undefined
      ? CallSideband.layerNone
      : Layer.succeed(CallSideband, CallSideband.of({ attach: bindings.attachSideband }))
  )

export const workerLayer = (bindings: WorkerBindings, overrides: PlatformOverrides = {}) =>
  Layer.mergeAll(ConnectLinks.layer, DesktopAccess.layer, openaiLayer(bindings, overrides)).pipe(
    Layer.provideMerge(Layer.mergeAll(ModelConnect.layer, Access.layer, AppLinks.layer, Mailer.layer(bindings.email))),
    Layer.provideMerge(
      platformLayer({ d1: bindings.d1, fetchProject: bindings.fetchProject, fetchRelay: noRelays }, overrides)
    ),
    Layer.provideMerge(MediaStore.layer(bindings.r2)),
    Layer.provideMerge(UpdateAssets.layer(bindings.updates)),
    Layer.provideMerge(Layer.succeed(LiveForwarder, LiveForwarder.of({ forward: bindings.forwardLive })))
  )

/**
 * Every five minutes: refresh credentials that expire soon, push them to sandboxes, tell projects about OAuth
 * connections whose provider stopped renewing them, end abandoned sign-ins, kill forgotten throwaway sandboxes.
 */
export const maintenance = Effect.gen(function* () {
  const store = yield* CredentialStore
  const directory = yield* ProjectDirectory
  const modelConnect = yield* ModelConnect
  const reaper = yield* SandboxReaper
  const { changed, lapsed } = yield* store.sweep
  for (const userId of changed) yield* directory.credentialsChanged(userId)
  // Every sandbox of theirs drops it; the projects that asked for it hear why.
  for (const { userId, integration, failure } of lapsed) yield* directory.integrationGone(userId, integration, failure)
  yield* modelConnect.cleanup
  yield* reaper.sweep
  yield* sweepBackgroundResponses
}).pipe(Effect.withSpan("maintenance"))

/**
 * Every hour: the metering ledger's backfills. E2B runs a webhook delivery missed (the last day; at midnight UTC,
 * the whole week E2B keeps), and yesterday's stored bytes per project. Then the resource review's telemetry: how
 * hard each sandbox that ran lately worked, and old wake notes dropped.
 */
export const hourlyMetering = Effect.gen(function* () {
  yield* (yield* E2BMetering).hourly
  yield* (yield* StorageMeter).recordDay
  yield* (yield* SandboxUsage).hourly
  yield* (yield* SandboxWakes).prune
}).pipe(Effect.withSpan("hourlyMetering"))
