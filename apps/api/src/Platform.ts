/**
 * The services both the Worker and the ProjectDO run on, assembled from what
 * workerd hands them per invocation: the D1 binding, and a way to reach any
 * project's DO. Config is read from the environment when this is built.
 */
import { D1Client } from "@effect/sql-d1"
import type { D1Database } from "@cloudflare/workers-types"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Tokens } from "./auth/Tokens.ts"
import { Browserbase } from "./brokers/Browserbase.ts"
import { Namespace } from "./brokers/Namespace.ts"
import { ApiConfig } from "./Config.ts"
import { ChatGpt } from "./connect/ChatGpt.ts"
import { Connections } from "./db/Connections.ts"
import { Projects } from "./db/Projects.ts"
import { Secrets } from "./db/Secrets.ts"
import { Users } from "./db/Users.ts"
import { Daemon } from "./e2b/Daemon.ts"
import { E2B } from "./e2b/E2B.ts"
import { Envd } from "./e2b/Envd.ts"
import { CredentialStore } from "./integrations/CredentialStore.ts"
import { Google } from "./integrations/Google.ts"
import { KeyFiles } from "./integrations/KeyFiles.ts"
import { OAuth, OAuthProviders } from "./integrations/OAuth.ts"
import { SandboxCredentials } from "./integrations/SandboxCredentials.ts"
import { ProjectClients, ProjectDirectory, type ProjectFetch } from "./project/Client.ts"
import { Apns } from "./push/Apns.ts"

export interface PlatformBindings {
  readonly d1: D1Database
  readonly fetchProject: ProjectFetch
}

/** D1 repositories over one D1 client. */
export const databaseLayer = (d1: D1Database) =>
  Layer.mergeAll(Users.layer, Projects.layer, Connections.layer, Secrets.layer).pipe(
    Layer.provide(D1Client.layer({ db: d1 }).pipe(Layer.orDie))
  )

/** Everything above the database: providers, credentials, and the project clients. */
export const servicesLayer = Layer.mergeAll(
  E2B.layer,
  Envd.layer,
  Daemon.layer,
  Apns.layer,
  Browserbase.layer,
  Namespace.layer,
  Google.layer,
  OAuthProviders.layer,
  OAuth.layer,
  ChatGpt.layer,
  Tokens.layer
)

/** Replaceable parts, so tests can run the same wiring against fakes and fixed config. */
export interface PlatformOverrides {
  readonly services?: typeof servicesLayer | undefined
  readonly config?: Layer.Layer<ApiConfig> | undefined
}

export const platformLayer = (bindings: PlatformBindings, overrides: PlatformOverrides = {}) => {
  const base = Layer.mergeAll(
    databaseLayer(bindings.d1),
    overrides.services ?? servicesLayer,
    ProjectClients.layer(bindings.fetchProject)
  ).pipe(Layer.provideMerge(FetchHttpClient.layer))
  const credentials = CredentialStore.layer.pipe(
    Layer.provideMerge(ProjectDirectory.layer.pipe(Layer.provideMerge(base)))
  )
  return Layer.mergeAll(SandboxCredentials.layer, KeyFiles.layer).pipe(
    Layer.provideMerge(credentials),
    Layer.provideMerge(overrides.config ?? ApiConfig.layer)
  )
}
