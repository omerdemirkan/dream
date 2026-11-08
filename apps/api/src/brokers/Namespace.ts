/**
 * Namespace compute: Apple-silicon Macs with Xcode and simulators, rented by
 * the minute (Connect JSON over HTTPS, bearer token). There's no idle stop on
 * the provider side, only a deadline, which the workspace's policy caps (four
 * hours from creation on Dream's plan); the ProjectDO looks at what's running
 * on a Mac (`run`, through Namespace's command service, no ssh), stops it once
 * nothing has for a while, and keeps the deadline a little ahead while it's in use.
 */
import { UpstreamFailure } from "@dream/domain"
import { Context, DateTime, Effect, Layer, Redacted, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ApiConfig, required } from "../Config.ts"
import { fromBase64, fromUtf8 } from "../lib/Bytes.ts"
import { describe, okOrFail } from "../e2b/E2B.ts"

const service = "/namespace.cloud.compute.v1beta.ComputeService"
const commandService = "/namespace.cloud.compute.v1beta.CommandService"

/** Every Mac Dream rents: the smallest macOS shape (also what metering records). */
export const MacShape = { virtualCpu: 4, memoryMegabytes: 7168 } as const

const Metadata = Schema.Struct({
  instanceId: Schema.String,
  status: Schema.optionalKey(Schema.String),
  deadline: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(Schema.String),
  readyAt: Schema.optionalKey(Schema.String),
  destroyedAt: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })))
})

const Created = Schema.Struct({ metadata: Metadata })
const Described = Schema.Struct({ metadata: Metadata })
const Listed = Schema.Struct({
  instances: Schema.optionalKey(Schema.Array(Metadata)),
  paginationCursor: Schema.optionalKey(Schema.String)
})

const Extended = Schema.Struct({ newDeadline: Schema.optionalKey(Schema.String) })

/** `RunCommandSync`'s answer: the output as base64 (proto3 JSON bytes); a zero exit code is left out. */
const Ran = Schema.Struct({
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Int)
})

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
  readonly createdAt?: DateTime.Utc | undefined
  readonly destroyedAt?: DateTime.Utc | undefined
  readonly labels?: Readonly<Record<string, string>> | undefined
}

export interface MacCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface MacSsh {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly privateKey: string
  readonly hostKey?: string | undefined
}

const time = (iso: string | undefined) => (iso === undefined ? undefined : DateTime.makeUnsafe(iso))

const toInstance = (metadata: typeof Metadata.Type): MacInstance => ({
  instanceId: metadata.instanceId,
  status: metadata.status ?? "STATUS_UNKNOWN",
  deadline: time(metadata.deadline),
  createdAt: time(metadata.createdAt),
  destroyedAt: time(metadata.destroyedAt),
  labels: metadata.labels === undefined ? undefined : Object.fromEntries(metadata.labels.map((l) => [l.name, l.value]))
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
    /** The workspace's current instances (every Mac, not only Dream's). */
    readonly list: Effect.Effect<ReadonlyArray<MacInstance>, UpstreamFailure>
    readonly ssh: (instanceId: string) => Effect.Effect<MacSsh, UpstreamFailure>
    /** Keeps the Mac up at least this much longer; answers the deadline Namespace set (its policy caps it). */
    readonly extend: (
      instanceId: string,
      ensureMinimumSeconds: number
    ) => Effect.Effect<DateTime.Utc | undefined, UpstreamFailure>
    /** Runs a command on the Mac as its user, without ssh, and waits for it (Namespace's command service). */
    readonly run: (
      instanceId: string,
      command: ReadonlyArray<string>
    ) => Effect.Effect<MacCommandResult, UpstreamFailure>
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
        schema: S,
        path = service
      ) =>
        Effect.gen(function* () {
          const token = yield* required(config.namespaceToken, "Namespace", "NAMESPACE_TOKEN")
          return yield* HttpClientRequest.post(`${config.namespaceApiUrl}${path}/${method}`).pipe(
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
              ...MacShape,
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
          Extended
        ).pipe(Effect.map((r) => time(r.newDeadline)))

      const run = (instanceId: string, command: ReadonlyArray<string>) =>
        call(
          "Running a command on the Mac",
          "RunCommandSync",
          { instanceId, command: { command } },
          Ran,
          commandService
        ).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(failure("Running a command on the Mac")("no answer in 30 seconds"))
          }),
          Effect.map((r) => ({
            exitCode: r.exitCode ?? 0,
            stdout: fromUtf8(fromBase64(r.stdout ?? "")),
            stderr: fromUtf8(fromBase64(r.stderr ?? ""))
          }))
        )

      const destroy = (instanceId: string) =>
        call("Stopping the Mac", "DestroyInstance", { instanceId, reason: "Dream: stopped" }, Schema.Unknown).pipe(
          Effect.asVoid
        )

      const list = Effect.gen(function* () {
        const all: Array<MacInstance> = []
        let cursor: string | undefined
        do {
          const page = yield* call("Listing Macs", "ListInstances", cursor ? { paginationCursor: cursor } : {}, Listed)
          all.push(...(page.instances ?? []).map(toInstance))
          cursor = page.paginationCursor || undefined
        } while (cursor !== undefined)
        return all
      })

      return Namespace.of({ start, describe: describeInstance, list, ssh, extend, run, destroy })
    })
  )
}
