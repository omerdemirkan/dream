/**
 * How the `dream` CLI reaches Dream: `SandboxRpcs` over HTTP on dreamd's Unix
 * socket. dreamd adds the project token and forwards to the API, so the CLI
 * holds no credential and attaches nothing itself.
 */
import {
  DaemonEnv,
  DefaultDaemonSocket,
  EmailLimitReached,
  HttpRpcSerialization,
  InvalidRequest,
  NotFound,
  Routes,
  SandboxAuth,
  SandboxRpcs,
  Unauthorized,
  UpstreamFailure
} from "@dream/domain"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Context, Effect, Layer, Predicate } from "effect"
import { CliError } from "effect/cli"
import { RpcClient, RpcClientError, RpcMiddleware } from "effect/rpc"

export class Dream extends Context.Service<
  Dream,
  RpcClient.FromGroup<typeof SandboxRpcs, RpcClientError.RpcClientError>
>()("@dream/dreamd/cli/Dream") {
  static readonly layer = Layer.effect(Dream, RpcClient.make(SandboxRpcs)).pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const socketPath = yield* Config.NonEmptyString(DaemonEnv.socket).pipe(
            Config.withDefault(DefaultDaemonSocket)
          )
          return Layer.mergeAll(
            RpcClient.layerProtocolHttp({ url: `http://dreamd${Routes.sandbox}` }).pipe(
              Layer.provide([NodeHttpClient.layerNodeHttpOptions({ socketPath }), HttpRpcSerialization])
            ),
            RpcMiddleware.layerClient(SandboxAuth, ({ request, next }) => next(request))
          )
        })
      )
    )
  )
}

/** One line for whoever ran the command (usually the agent), for any failure. */
export const describeError = (error: unknown): string => {
  if (error instanceof NotFound) return `No ${error.entity} ${error.id}.`
  if (error instanceof InvalidRequest || error instanceof Unauthorized || error instanceof EmailLimitReached) {
    return error.message
  }
  if (error instanceof UpstreamFailure) return `${error.service} failed: ${error.message}`
  if (error instanceof RpcClientError.RpcClientError) {
    const cause = Predicate.hasProperty(error.reason, "cause") ? String(error.reason.cause) : error.message
    return `Couldn't reach Dream through dreamd: ${cause}. dreamd may be restarting; try again in a few seconds.`
  }
  return error instanceof Error ? error.message : String(error)
}

/** Whether a call died because the API predates it: Effect's RPC server answers a tag it doesn't know that way. */
export const isUnknownToApi = (defect: unknown): boolean => {
  const text = Predicate.hasProperty(defect, "message") ? String(defect.message) : String(defect)
  return text.includes("Unknown request tag")
}

/**
 * For calls added after the first release (`dream work`): against an API that predates them, fail with `message`
 * instead of a defect. Other defects stay defects.
 */
export const newerThanApi =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        isUnknownToApi(defect)
          ? Effect.fail(new CliError.UserError({ cause: defect, userMessage: message }))
          : Effect.die(defect)
      )
    )

/** Fail a command with `describeError`'s line, which the CLI prints to stderr (exit code 1). */
export const userFacing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: describeError(cause) })))
