/**
 * What the Worker runs on per invocation, and its scheduled maintenance.
 * Kept apart from Api.ts (which needs workerd) so tests can build it.
 */
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"
import { Effect, Layer } from "effect"
import { ConnectLinks } from "./connect/ConnectLinks.ts"
import { ModelConnect } from "./connect/ModelConnect.ts"
import { MediaStore } from "./http/Media.ts"
import { LiveForwarder } from "./http/Router.ts"
import { UpdateAssets } from "./http/Updates.ts"
import { Access } from "./integrations/Access.ts"
import { CredentialStore } from "./integrations/CredentialStore.ts"
import { AppLinks } from "./links/AppLinks.ts"
import { type PlatformOverrides, platformLayer } from "./Platform.ts"
import { type ProjectFetch, ProjectDirectory } from "./project/Client.ts"

export interface WorkerBindings {
  readonly d1: D1Database
  readonly r2: R2Bucket | undefined
  /** The over-the-air updates bucket (`Resources.Updates`). */
  readonly updates: R2Bucket | undefined
  readonly fetchProject: ProjectFetch
  readonly forwardLive: LiveForwarder["Service"]["forward"]
}

export const workerLayer = (bindings: WorkerBindings, overrides: PlatformOverrides = {}) =>
  ConnectLinks.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(ModelConnect.layer, Access.layer, AppLinks.layer)),
    Layer.provideMerge(platformLayer({ d1: bindings.d1, fetchProject: bindings.fetchProject }, overrides)),
    Layer.provideMerge(MediaStore.layer(bindings.r2)),
    Layer.provideMerge(UpdateAssets.layer(bindings.updates)),
    Layer.provideMerge(Layer.succeed(LiveForwarder, LiveForwarder.of({ forward: bindings.forwardLive })))
  )

/**
 * Every five minutes: refresh credentials that expire soon, push them to sandboxes, tell projects about OAuth
 * connections whose provider stopped renewing them, end abandoned sign-ins.
 */
export const maintenance = Effect.gen(function* () {
  const store = yield* CredentialStore
  const directory = yield* ProjectDirectory
  const modelConnect = yield* ModelConnect
  const { changed, lapsed } = yield* store.sweep
  for (const userId of changed) yield* directory.credentialsChanged(userId)
  // Every sandbox of theirs drops it; the projects that asked for it hear why.
  for (const { userId, integration, failure } of lapsed) yield* directory.integrationGone(userId, integration, failure)
  yield* modelConnect.cleanup
}).pipe(Effect.withSpan("maintenance"))
