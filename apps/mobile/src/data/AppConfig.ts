/**
 * Settings baked into the build by app.config.ts (`extra`). Decoded once at
 * startup; a malformed value falls back to the defaults below, since the app
 * can still run against the fixtures.
 */
import { Context, Exit, Layer, Schema } from "effect"

export const Backend = Schema.Literals(["fixtures", "live"])
export type Backend = typeof Backend.Type

export const AppConfigSchema = Schema.Struct({
  /** The API origin, e.g. "https://dream.omer.build". RPC, live sockets and media hang off it. */
  apiUrl: Schema.String,
  /** "fixtures" runs the whole app against an in-memory fake of the API. */
  backend: Backend,
  /** iOS OAuth client id for native Google Sign-In; absent hides the button. */
  googleIosClientId: Schema.optionalKey(Schema.String)
})
export type AppConfigShape = typeof AppConfigSchema.Type

export const defaultConfig: AppConfigShape = { apiUrl: "https://dream.omer.build", backend: "fixtures" }

export const decodeAppConfig = (extra: unknown): AppConfigShape => {
  const exit = Schema.decodeUnknownExit(AppConfigSchema)(extra, { onExcessProperty: "ignore" })
  return Exit.isSuccess(exit) ? { ...exit.value, apiUrl: exit.value.apiUrl.replace(/\/+$/, "") } : defaultConfig
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("@dream/mobile/AppConfig") {
  static readonly layer = (config: AppConfigShape) => Layer.succeed(AppConfig, config)
}
