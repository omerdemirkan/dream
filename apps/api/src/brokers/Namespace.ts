/**
 * Namespace compute: Apple-silicon Macs with Xcode and simulators, rented by
 * the minute (Connect JSON over HTTPS, bearer token). There's no idle stop on
 * the provider side, only a deadline; the ProjectDO stops a Mac after 20 idle
 * minutes and keeps the deadline a little ahead while it's in use.
 */
import { UpstreamFailure } from "@dream/domain"
import { Context, DateTime, Effect, Layer, Redacted, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ApiConfig, required } from "../Config.ts"
import { fromBase64, fromUtf8 } from "../lib/Bytes.ts"
import { describe, okOrFail } from "../e2b/E2B.ts"

const service = "/namespace.cloud.compute.v1beta.ComputeService"

const Metadata = Schema.Struct({
  instanceId: Schema.String,
  status: Schema.optionalKey(Schema.String),
  deadline: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(Schema.String),
  readyAt: Schema.optionalKey(Schema.String)
})

const Created = Schema.Struct({ metadata: Metadata })
const Described = Schema.Struct({ metadata: Metadata })

const SshConfig = Schema.Struct({
  sshPrivateKey: Schema.String,
  username: Schema.String,
  endpoint: Schema.String,
  sshHostKeys: Schema.optionalKey(Schema.Array(Schema.String))
})

export interface MacInstance {
  readonly instanceId: string
  readonly status: string
  readonly deadline?: DateTime.Utc | undefined
}

export interface MacSsh {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly privateKey: string
  readonly hostKey?: string | undefined
}

const toInstance = (metadata: typeof Metadata.Type): MacInstance => ({
  instanceId: metadata.instanceId,
  status: metadata.status ?? "STATUS_UNKNOWN",
  deadline: metadata.deadline === undefined ? undefined : DateTime.makeUnsafe(metadata.deadline)
})

export class Namespace extends Context.Service<
  Namespace,
  {
    /** Creates a Mac and waits until it's RUNNING. */
    readonly start: (
      labels: Readonly<Record<string, string>>,
      deadline: DateTime.Utc
    ) => Effect.Effect<MacInstance, UpstreamFailure>
    readonly describe: (instanceId: string) => Effect.Effect<MacInstance, UpstreamFailure>
    readonly ssh: (instanceId: string) => Effect.Effect<MacSsh, UpstreamFailure>
    readonly extend: (instanceId: string, ensureMinimumSeconds: number) => Effect.Effect<void, UpstreamFailure>
    readonly destroy: (instanceId: string) => Effect.Effect<void, UpstreamFailure>
  }
>()("@dream/api/Namespace") {
  static readonly layer = Layer.effect(
    Namespace,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const http = yield* HttpClient.HttpClient

      const failure = (what: string) => (cause: unknown) =>
        new UpstreamFailure({ service: "Namespace", message: `${what} failed: ${describe(cause)}` })

      const call = <S extends Schema.Codec<any, any, never, never>>(
        what: string,
        method: string,
        body: object,
        schema: S
      ) =>
        Effect.gen(function* () {
          const token = yield* required(config.namespaceToken, "Namespace", "NAMESPACE_TOKEN")
          return yield* HttpClientRequest.post(`${config.namespaceApiUrl}${service}/${method}`).pipe(
            HttpClientRequest.setHeaders({ authorization: `Bearer ${Redacted.value(token)}` }),
            HttpClientRequest.bodyJsonUnsafe(body),
            http.execute,
            Effect.flatMap(okOrFail),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.mapError(failure(what))
          )
        })

      const describeInstance = (instanceId: string) =>
        call("Reading the Mac", "DescribeInstance", { instanceId }, Described).pipe(
          Effect.map((r) => toInstance(r.metadata))
        )

      const start = Effect.fn("Namespace.start")(function* (
        labels: Readonly<Record<string, string>>,
        deadline: DateTime.Utc
      ) {
        const created = yield* call(
          "Starting a Mac",
          "CreateInstance",
          {
            shape: {
              virtualCpu: 4,
              memoryMegabytes: 7168,
              os: "macos",
              machineArch: "arm64",
              selectors: [{ name: "macos.version", value: "27.x" }]
            },
            documentedPurpose: "Dream: the agent's Mac for iOS builds",
            labels: Object.entries(labels).map(([name, value]) => ({ name, value })),
            deadline: DateTime.formatIso(deadline)
          },
          Created
        )
        const instanceId = created.metadata.instanceId
        return yield* describeInstance(instanceId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (instance) =>
              instance.status === "RUNNING" || instance.status === "ERROR" || instance.status === "DESTROYED",
            times: 40
          }),
          Effect.flatMap((instance) =>
            instance.status === "RUNNING"
              ? Effect.succeed(instance)
              : destroy(instanceId).pipe(
                  Effect.ignore,
                  Effect.andThen(Effect.fail(failure("Starting a Mac")(`it ended up ${instance.status}`)))
                )
          )
        )
      })

      const ssh = Effect.fn("Namespace.ssh")(function* (instanceId: string) {
        const response = yield* call("Getting SSH access", "GetSSHConfig", { instanceId }, SshConfig)
        const hostKey = response.sshHostKeys?.[0]
        return {
          host: response.endpoint,
          port: 22,
          user: response.username,
          privateKey: fromUtf8(fromBase64(response.sshPrivateKey)),
          hostKey: hostKey === undefined ? undefined : `${response.endpoint} ${fromUtf8(fromBase64(hostKey)).trim()}`
        }
      })

      const extend = (instanceId: string, ensureMinimumSeconds: number) =>
        call(
          "Extending the Mac",
          "ExtendInstance",
          { instanceId, ensureMinimum: `${ensureMinimumSeconds}s` },
          Schema.Unknown
        ).pipe(Effect.asVoid)

      const destroy = (instanceId: string) =>
        call("Stopping the Mac", "DestroyInstance", { instanceId, reason: "Dream: stopped" }, Schema.Unknown).pipe(
          Effect.asVoid
        )

      return Namespace.of({ start, describe: describeInstance, ssh, extend, destroy })
    })
  )
}
