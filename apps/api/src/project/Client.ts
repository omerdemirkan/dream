/**
 * Calling a ProjectDO from the Worker (or from another ProjectDO): an
 * RpcClient for `ProjectRpcs` + `SandboxRpcs` over the DO's `fetch`. The
 * project token was checked by the Worker already, so the client-side
 * SandboxAuth middleware attaches nothing.
 */
import {
  HttpRpcSerialization,
  type ProjectId,
  SandboxAuth,
  SandboxRpcs,
  type UserId,
  type UsageWindowName
} from "@dream/domain"
import { Context, DateTime, Effect, Layer } from "effect"
import { HttpClient, type HttpClientError, type HttpClientRequest, type HttpClientResponse } from "effect/http"
import { RpcClient, type RpcClientError, RpcMiddleware } from "effect/rpc"
import { Projects } from "../db/Projects.ts"
import { InternalRpcPath, ProjectRpcs } from "./ProjectRpcs.ts"

export class DoRpcs extends ProjectRpcs.merge(SandboxRpcs) {}

export type ProjectClient = RpcClient.FromGroup<typeof DoRpcs, RpcClientError.RpcClientError>

/** `fetch` into the DO named by a project id. */
export type ProjectFetch = (
  projectId: ProjectId,
  request: HttpClientRequest.HttpClientRequest
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>

const passThroughAuth = RpcMiddleware.layerClient(SandboxAuth, ({ request, next }) => next(request))

export class ProjectClients extends Context.Service<
  ProjectClients,
  {
    /** Runs `use` with a client for one project. Transport failures are defects. */
    readonly use: <A, E>(
      projectId: ProjectId,
      use: (client: ProjectClient) => Effect.Effect<A, E | RpcClientError.RpcClientError>
    ) => Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError>>
  }
>()("@dream/api/project/ProjectClients") {
  static readonly layer = (fetch: ProjectFetch) =>
    Layer.succeed(
      ProjectClients,
      ProjectClients.of({
        use: (projectId, use) => {
          const http = HttpClient.make((request) => fetch(projectId, request))
          const protocol = RpcClient.layerProtocolHttp({ url: `https://project${InternalRpcPath}` }).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
            Layer.provide(HttpRpcSerialization)
          )
          return RpcClient.make(DoRpcs).pipe(
            Effect.flatMap(use),
            Effect.catchTag("RpcClientError" as any, (error: unknown) => Effect.die(error)),
            Effect.provide(Layer.merge(protocol, passThroughAuth)),
            Effect.scoped
          ) as any
        }
      })
    )
}

/** Fan-out to every project of a person. */
export class ProjectDirectory extends Context.Service<
  ProjectDirectory,
  {
    readonly credentialsChanged: (userId: UserId) => Effect.Effect<void>
    readonly usageLimited: (
      userId: UserId,
      window: UsageWindowName,
      until: DateTime.Utc,
      except: ProjectId
    ) => Effect.Effect<void>
  }
>()("@dream/api/project/ProjectDirectory") {
  static readonly layer = Layer.effect(
    ProjectDirectory,
    Effect.gen(function* () {
      const projects = yield* Projects
      const clients = yield* ProjectClients
      const each = (userId: UserId, f: (projectId: ProjectId) => Effect.Effect<void>) =>
        Effect.flatMap(projects.projectIdsFor(userId), (ids) =>
          Effect.forEach(
            ids,
            (id) => f(id).pipe(Effect.catchCause((cause) => Effect.logWarning("project fan-out failed", cause))),
            {
              concurrency: 4,
              discard: true
            }
          )
        )
      return ProjectDirectory.of({
        credentialsChanged: (userId) =>
          each(userId, (projectId) => clients.use(projectId, (client) => client.CredentialsChanged())),
        usageLimited: (userId, window, until, except) =>
          each(userId, (projectId) =>
            projectId === except
              ? Effect.void
              : clients.use(projectId, (client) => client.UsageLimited({ window, until }))
          )
      })
    })
  )
}
