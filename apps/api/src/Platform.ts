/**
 * The services both the Worker and the ProjectDO run on, assembled from what
 * workerd hands them per invocation: the D1 binding, and a way to reach any
 * project's DO and any relay's. Config is read from the environment when this is built.
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
import { ClientErrors } from "./db/ClientErrors.ts"
import { Connections } from "./db/Connections.ts"
import { DesktopLinks } from "./db/DesktopLinks.ts"
import { Attachments } from "./db/Attachments.ts"
import { Links } from "./db/Links.ts"
import { Projects } from "./db/Projects.ts"
import { RateLimits } from "./db/RateLimits.ts"
import { Secrets } from "./db/Secrets.ts"
import { TestflightGrants } from "./db/TestflightGrants.ts"
import { TestflightIdentity } from "./db/TestflightIdentity.ts"
import { TurnUsageLog } from "./db/TurnUsage.ts"
import { MacActivityLog } from "./db/MacActivity.ts"
import { UpdateStore } from "./db/Updates.ts"
import { Users } from "./db/Users.ts"
import { Daemon } from "./e2b/Daemon.ts"
import { E2B } from "./e2b/E2B.ts"
import { SandboxReaper } from "./e2b/Reaper.ts"
import { Envd } from "./e2b/Envd.ts"
import { CredentialStore } from "./integrations/CredentialStore.ts"
import { Google } from "./integrations/Google.ts"
import { KeyFiles } from "./integrations/KeyFiles.ts"
import { OAuth, OAuthProviders } from "./integrations/OAuth.ts"
import { SandboxCredentials } from "./integrations/SandboxCredentials.ts"
import { ProjectClients, ProjectDirectory, type ProjectFetch } from "./project/Client.ts"
import { Apns } from "./push/Apns.ts"
import { RelayClients, type RelayFetch } from "./relay/RelayClients.ts"
import { E2BEvents } from "./metering/E2BEvents.ts"
import { E2BMetering } from "./metering/E2BMetering.ts"
import { MeterD1 } from "./metering/MeterD1.ts"
import { CostReport } from "./metering/Report.ts"
import { StorageMeter } from "./metering/Storage.ts"
import { UsageReport } from "./usage/ProjectUsage.ts"
import { OpenAIObjects } from "./openai/Objects.ts"
import type { OpenAIUpstream } from "./openai/Runtime.ts"

export interface PlatformBindings {
  readonly d1: D1Database
  readonly fetchProject: ProjectFetch
  readonly fetchRelay: RelayFetch
}

/** D1 repositories over one D1 client. */
export const databaseLayer = (d1: D1Database) =>
  Layer.mergeAll(
    Users.layer,
    Projects.layer,
    Links.layer,
    Attachments.layer,
    Connections.layer,
    Secrets.layer,
    TestflightGrants.layer,
    TestflightIdentity.layer,
    UpdateStore.layer,
    TurnUsageLog.layer,
    MacActivityLog.layer,
    DesktopLinks.layer,
    RateLimits.layer,
    ClientErrors.layer,
    MeterD1,
    OpenAIObjects.layer
  ).pipe(Layer.provide(D1Client.layer({ db: d1 }).pipe(Layer.orDie)))

/** The ledger's readers and feeders, over D1 and the services above it. */
export const meteringLayer = (d1: D1Database) =>
  Layer.mergeAll(E2BMetering.layer, CostReport.layer, StorageMeter.layer).pipe(
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
  E2BEvents.layer,
  Google.layer.pipe(Layer.provideMerge(OAuth.layer)),
  OAuthProviders.layer,
  ChatGpt.layer,
  Tokens.layer
)

/** Replaceable parts, so tests can run the same wiring against fakes and fixed config. */
export interface PlatformOverrides {
  readonly services?: typeof servicesLayer | undefined
  readonly config?: Layer.Layer<ApiConfig> | undefined
  /** The OpenAI gateway's connection to OpenAI (WorkerLayer.ts). */
  readonly openaiUpstream?: Layer.Layer<OpenAIUpstream> | undefined
}

export const platformLayer = (bindings: PlatformBindings, overrides: PlatformOverrides = {}) => {
  const base = Layer.mergeAll(
    databaseLayer(bindings.d1),
    overrides.services ?? servicesLayer,
    ProjectClients.layer(bindings.fetchProject),
    RelayClients.layer(bindings.fetchRelay)
  ).pipe(Layer.provideMerge(FetchHttpClient.layer))
  const credentials = CredentialStore.layer.pipe(
    Layer.provideMerge(ProjectDirectory.layer.pipe(Layer.provideMerge(base)))
  )
  return Layer.mergeAll(
    SandboxCredentials.layer,
    KeyFiles.layer,
    UsageReport.layer,
    SandboxReaper.layer,
    meteringLayer(bindings.d1)
  ).pipe(Layer.provideMerge(credentials), Layer.provideMerge(overrides.config ?? ApiConfig.layer))
}
