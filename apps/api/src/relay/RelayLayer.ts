/**
 * A RelayDO's services over its SQLite storage and native alarm, and its RPC handlers. Kept apart from RelayDO.ts
 * (which needs workerd) so tests, and the throwaway probe Worker, can build it.
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import { Config, Effect, Layer } from "effect"
import { NativeAlarm } from "../project/Alarm.ts"
import { DiscordEndpoints } from "./Discord.ts"
import { RelayRpcs } from "./RelayRpcs.ts"
import { migrate, RelayStore } from "./RelayStore.ts"
import { RelayRuntime } from "./Runtime.ts"

export const relayLayer = (
  storage: DurableObjectStorage,
  nativeAlarm: Layer.Layer<NativeAlarm> = NativeAlarm.fromStorage(storage)
) => {
  const sql = SqliteClient.layer({ storage })
  const store = Layer.mergeAll(RelayStore.layer, Layer.effectDiscard(migrate)).pipe(Layer.provide(sql))
  return RelayRuntime.layer.pipe(Layer.provideMerge(store), Layer.provide(nativeAlarm))
}

export const RelayHandlers = RelayRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* RelayRuntime
    return {
      Start: ({ config }) => runtime.start(config),
      Stop: () => runtime.stop,
      Restart: () => runtime.restart,
      Status: () => runtime.status
    }
  })
)

/**
 * Where relays find Discord: Discord itself, unless the operator points them elsewhere for a test (`DISCORD_API_URL`,
 * `DISCORD_GATEWAY_HOST`, plain Worker vars).
 */
export const discordEndpointsFromEnv = Layer.unwrap(
  Effect.gen(function* () {
    const api = yield* Config.String("DISCORD_API_URL").pipe(Config.withDefault("https://discord.com/api/v10"))
    const gatewayHost = yield* Config.String("DISCORD_GATEWAY_HOST").pipe(Config.withDefault("discord.gg"))
    return DiscordEndpoints.layerFrom(api, gatewayHost)
  }).pipe(Effect.orDie)
)
