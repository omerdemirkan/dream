/**
 * The project, as a RelayDO sees it: the ProjectDO that owns the relay, reached over `ProjectRpcs`. It hands events
 * on to dreamd, decrypts the relay's key, tells the agent things, and says whether the relay is still wanted. When
 * the answer is that the relay isn't the project's any more, the RelayDO closes its line and forgets everything.
 */
import {
  type InvalidRequest,
  type ProjectId,
  type RelayForward,
  type RelayForwardResult,
  type RelayId
} from "@dream/domain"
import { Context, Data, Effect, Layer, Ref } from "effect"
import { ProjectClients } from "../project/Client.ts"
import type { RelayCredential } from "../project/ProjectRpcs.ts"

/** The project no longer holds this relay: it was removed, or the project archived or deleted. */
export class RelayGone extends Data.TaggedError("RelayGone")<{}> {}

export interface RelayHostShape {
  readonly deliver: (
    projectId: ProjectId,
    relayId: RelayId,
    deliveries: readonly [RelayForward, ...Array<RelayForward>]
  ) => Effect.Effect<RelayForwardResult, RelayGone>
  readonly credential: (
    projectId: ProjectId,
    relayId: RelayId
  ) => Effect.Effect<RelayCredential, RelayGone | InvalidRequest>
  readonly alert: (projectId: ProjectId, relayId: RelayId, reason: string) => Effect.Effect<void, RelayGone>
  readonly active: (projectId: ProjectId, relayId: RelayId) => Effect.Effect<boolean>
}

export class RelayHost extends Context.Service<RelayHost, RelayHostShape>()("@dream/api/relay/RelayHost") {
  static readonly layer = Layer.effect(
    RelayHost,
    Effect.gen(function* () {
      const clients = yield* ProjectClients
      const gone = () => Effect.fail(new RelayGone())
      return RelayHost.of({
        deliver: (projectId, relayId, deliveries) =>
          clients
            .use(projectId, (client) => client.RelayDeliver({ relayId, deliveries }))
            .pipe(Effect.catchTag("NotFound", gone)),
        credential: (projectId, relayId) =>
          clients
            .use(projectId, (client) => client.RelayCredential({ relayId }))
            .pipe(Effect.catchTag("NotFound", gone)),
        alert: (projectId, relayId, reason) =>
          clients
            .use(projectId, (client) => client.RelayAlert({ relayId, reason }))
            .pipe(Effect.catchTag("NotFound", gone)),
        active: (projectId, relayId) => clients.use(projectId, (client) => client.RelayActive({ relayId }))
      })
    })
  )

  /** A project played by a test: whatever `shape` does, with each call recorded. */
  static readonly layerTest = (shape: RelayHostShape, calls?: Ref.Ref<ReadonlyArray<string>>) => {
    const record = (call: string) => (calls === undefined ? Effect.void : Ref.update(calls, (all) => [...all, call]))
    return Layer.succeed(
      RelayHost,
      RelayHost.of({
        deliver: (projectId, relayId, deliveries) =>
          Effect.andThen(
            record(`deliver ${deliveries.map((d) => d.id).join(",")}`),
            shape.deliver(projectId, relayId, deliveries)
          ),
        credential: (projectId, relayId) => Effect.andThen(record("credential"), shape.credential(projectId, relayId)),
        alert: (projectId, relayId, reason) =>
          Effect.andThen(record(`alert ${reason}`), shape.alert(projectId, relayId, reason)),
        active: (projectId, relayId) => Effect.andThen(record("active"), shape.active(projectId, relayId))
      })
    )
  }
}
