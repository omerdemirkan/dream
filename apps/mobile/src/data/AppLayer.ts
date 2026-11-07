/**
 * Everything the app's data layer needs, for either backend.
 *
 * The platform supplies the keychain, a fetch that can stream response bodies,
 * the WebSocket constructor, and a way to upload files; tests supply in-memory
 * and Node versions.
 */
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import type { Socket } from "effect/socket"
import { FakeBackend } from "../fake/FakeBackend.ts"
import { AppClientFake, LiveProjectsFake } from "../fake/layers.ts"
import { AppClient } from "./AppClient.ts"
import { AppConfig, type AppConfigShape } from "./AppConfig.ts"
import { Answers } from "./Answers.ts"
import { AttachmentUploads, FileTransfer } from "./AttachmentUploads.ts"
import { LiveProjects } from "./LiveProjects.ts"
import { ProjectArchive } from "./ProjectArchive.ts"
import { ProjectStates } from "./ProjectStates.ts"
import { AccountUsages } from "./AccountUsages.ts"
import { ProjectUsages } from "./ProjectUsages.ts"
import { Replies } from "./Replies.ts"
import type { SecureStorage } from "./SecureStorage.ts"
import { Session } from "./Session.ts"

export interface Platform {
  readonly storage: Layer.Layer<SecureStorage>
  readonly webSocket: Layer.Layer<Socket.WebSocketConstructor>
  readonly fetch: typeof globalThis.fetch
  /** Uploads a local file's bytes; without one, attachments fail with a sentence. */
  readonly fileTransfer?: Layer.Layer<FileTransfer> | undefined
}

const backendLayer = (config: AppConfigShape, platform: Platform) =>
  config.backend === "fixtures"
    ? Layer.mergeAll(AppClientFake, LiveProjectsFake, FileTransfer.layerFake).pipe(
        Layer.provideMerge(FakeBackend.layer)
      )
    : Layer.mergeAll(LiveProjects.layerSocket, platform.fileTransfer ?? FileTransfer.layerUnavailable).pipe(
        Layer.provideMerge(AppClient.layerHttp),
        Layer.provide(Layer.mergeAll(platform.webSocket, Layer.succeed(FetchHttpClient.Fetch, platform.fetch)))
      )

export const makeAppLayer = (config: AppConfigShape, platform: Platform) =>
  Layer.mergeAll(
    Answers.layer,
    ProjectUsages.layer.pipe(Layer.provideMerge(ProjectStates.layer)),
    AccountUsages.layer,
    Replies.layer,
    ProjectArchive.layer,
    AttachmentUploads.layer
  ).pipe(
    Layer.provideMerge(backendLayer(config, platform)),
    Layer.provideMerge(Session.layer),
    Layer.provideMerge(Layer.mergeAll(AppConfig.layer(config), platform.storage))
  )
