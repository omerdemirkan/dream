/**
 * What the Worker runs on per invocation, and its scheduled maintenance.
 * Kept apart from Api.ts (which needs workerd) so tests can build it.
 */
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"
import { Effect, Layer } from "effect"
import { ModelConnect } from "./connect/ModelConnect.ts"
import { MediaStore } from "./http/Media.ts"
import { LiveForwarder } from "./http/Router.ts"
import { Access } from "./integrations/Access.ts"
import { CredentialStore } from "./integrations/CredentialStore.ts"
import { type PlatformOverrides, platformLayer } from "./Platform.ts"
import { type ProjectFetch, ProjectDirectory } from "./project/Client.ts"

export interface WorkerBindings {
  readonly d1: D1Database
  readonly r2: R2Bucket | undefined
  readonly fetchProject: ProjectFetch
  readonly forwardLive: LiveForwarder["Service"]["forward"]
}

export const workerLayer = (bindings: WorkerBindings, overrides: PlatformOverrides = {}) =>
  Layer.mergeAll(ModelConnect.layer, Access.layer).pipe(
    Layer.provideMerge(platformLayer({ d1: bindings.d1, fetchProject: bindings.fetchProject }, overrides)),
    Layer.provideMerge(MediaStore.layer(bindings.r2)),
    Layer.provideMerge(Layer.succeed(LiveForwarder, LiveForwarder.of({ forward: bindings.forwardLive })))
  )

/** Every five minutes: refresh credentials that expire soon, push them to sandboxes, end abandoned sign-ins. */
export const maintenance = Effect.gen(function* () {
  const store = yield* CredentialStore
  const directory = yield* ProjectDirectory
  const modelConnect = yield* ModelConnect
  for (const userId of yield* store.sweep) yield* directory.credentialsChanged(userId)
  yield* modelConnect.cleanup
}).pipe(Effect.withSpan("maintenance"))
