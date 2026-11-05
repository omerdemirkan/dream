/**
 * Everything the app's data layer needs, for either backend.
 *
 * The platform supplies the keychain, a fetch that can stream response bodies,
 * and the WebSocket constructor; tests supply in-memory and Node versions.
 */
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import type { Socket } from "effect/socket"
import { FakeBackend } from "../fake/FakeBackend.ts"
import { AppClientFake, LiveProjectsFake } from "../fake/layers.ts"
import { AppClient } from "./AppClient.ts"
import { AppConfig, type AppConfigShape } from "./AppConfig.ts"
import { Answers } from "./Answers.ts"
import { LiveProjects } from "./LiveProjects.ts"
import { ProjectStates } from "./ProjectStates.ts"
import { Replies } from "./Replies.ts"
import type { SecureStorage } from "./SecureStorage.ts"
import { Session } from "./Session.ts"

export interface Platform {
  readonly storage: Layer.Layer<SecureStorage>
  readonly webSocket: Layer.Layer<Socket.WebSocketConstructor>
  readonly fetch: typeof globalThis.fetch
}

const backendLayer = (config: AppConfigShape, platform: Platform) =>
  config.backend === "fixtures"
    ? Layer.mergeAll(AppClientFake, LiveProjectsFake).pipe(Layer.provideMerge(FakeBackend.layer))
    : LiveProjects.layerSocket.pipe(
        Layer.provideMerge(AppClient.layerHttp),
        Layer.provide(Layer.mergeAll(platform.webSocket, Layer.succeed(FetchHttpClient.Fetch, platform.fetch)))
      )

export const makeAppLayer = (config: AppConfigShape, platform: Platform) =>
  Layer.mergeAll(Answers.layer, ProjectStates.layer, Replies.layer).pipe(
    Layer.provideMerge(backendLayer(config, platform)),
    Layer.provideMerge(Session.layer),
    Layer.provideMerge(Layer.mergeAll(AppConfig.layer(config), platform.storage))
  )
