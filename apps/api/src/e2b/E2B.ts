/**
 * E2B's REST API (api.e2b.app): create, resume, pause and kill sandboxes, and
 * replace their egress rules. Plain fetch through Effect's HttpClient, because
 * the e2b SDK's Node dependencies don't belong in a Worker.
 *
 * Verified against the live API (2026-11-04): a paused sandbox can't have its
 * network updated (404), traffic to a port URL with the traffic token resumes
 * a paused sandbox in ~200 ms, and processes survive pause and resume.
 * (2026-11-05): a timeout past the plan's run cap is clamped to `startedAt` +
 * cap without an error, `startedAt` resets on resume, and setting the timeout
 * of a paused sandbox is a 404.
 */
import { UpstreamFailure } from "@dream/domain"
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ApiConfig, required } from "../Config.ts"

/** One header-injection rule set per host (exact, or `*.example.com`). */
export type NetworkRules = Readonly<
  Record<string, ReadonlyArray<{ readonly transform: { readonly headers: Readonly<Record<string, string>> } }>>
>

/** Everything needed to reach a sandbox. The tokens are secrets of Dream's, not the user's. */
export const SandboxAccess = Schema.Struct({
  sandboxId: Schema.String,
  domain: Schema.String,
  envdAccessToken: Schema.String,
  trafficAccessToken: Schema.String
})
export type SandboxAccess = typeof SandboxAccess.Type

const CreatedSandbox = Schema.Struct({
  sandboxID: Schema.String,
  domain: Schema.optionalKey(Schema.NullOr(Schema.String)),
  envdAccessToken: Schema.optionalKey(Schema.NullOr(Schema.String)),
  trafficAccessToken: Schema.optionalKey(Schema.NullOr(Schema.String)),
  envdVersion: Schema.optionalKey(Schema.String)
})

export const SandboxState = Schema.Literals(["running", "paused", "pausing", "killed", "snapshotting"])

const SandboxInfo = Schema.Struct({
  sandboxID: Schema.String,
  state: Schema.String,
  domain: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** When it last started or resumed: E2B's run cap counts from here. */
  startedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  endAt: Schema.optionalKey(Schema.String)
})
export type SandboxInfo = typeof SandboxInfo.Type

export class SandboxGone extends Data.TaggedError("SandboxGone")<{ readonly sandboxId: string }> {}

export interface CreateSandbox {
  readonly template: string
  /** Seconds until E2B pauses it (lifecycle onTimeout: pause). */
  readonly timeoutSeconds: number
  readonly autoPause: boolean
  readonly envVars: Readonly<Record<string, string>>
  readonly metadata: Readonly<Record<string, string>>
  readonly rules: NetworkRules
}

export class E2B extends Context.Service<
  E2B,
  {
    readonly create: (options: CreateSandbox) => Effect.Effect<SandboxAccess, UpstreamFailure>
    /** Resumes a paused sandbox (or just returns a running one) and sets its timeout. */
    readonly connect: (
      sandboxId: string,
      timeoutSeconds: number
    ) => Effect.Effect<SandboxAccess, UpstreamFailure | SandboxGone>
    readonly info: (sandboxId: string) => Effect.Effect<Option.Option<SandboxInfo>, UpstreamFailure>
    readonly setTimeout: (
      sandboxId: string,
      timeoutSeconds: number
    ) => Effect.Effect<void, UpstreamFailure | SandboxGone>
    /** Replaces the egress rules. A paused sandbox can't be updated: that's `SandboxGone`'s sibling, `false`. */
    readonly updateRules: (sandboxId: string, rules: NetworkRules) => Effect.Effect<boolean, UpstreamFailure>
    readonly pause: (sandboxId: string) => Effect.Effect<void, UpstreamFailure>
    readonly kill: (sandboxId: string) => Effect.Effect<void, UpstreamFailure>
  }
>()("@dream/api/E2B") {
  static readonly layer = Layer.effect(
    E2B,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const base = yield* HttpClient.HttpClient

      const client = Effect.map(required(config.e2bApiKey, "E2B", "E2B_API_KEY"), (key) =>
        base.pipe(
          HttpClient.mapRequest((request) =>
            request.pipe(
              HttpClientRequest.prependUrl(config.e2bApiUrl),
              HttpClientRequest.setHeader("X-API-KEY", Redacted.value(key)),
              HttpClientRequest.acceptJson
            )
          )
        )
      )

      const failure = (what: string) => (cause: unknown) =>
        new UpstreamFailure({ service: "E2B", message: `${what} failed: ${describe(cause)}` })

      const toAccess = (created: typeof CreatedSandbox.Type, fallback?: SandboxAccess): SandboxAccess => ({
        sandboxId: created.sandboxID,
        domain: created.domain ?? fallback?.domain ?? config.e2bDomain,
        envdAccessToken: created.envdAccessToken ?? fallback?.envdAccessToken ?? "",
        trafficAccessToken: created.trafficAccessToken ?? fallback?.trafficAccessToken ?? ""
      })

      const create = Effect.fn("E2B.create")(function* (options: CreateSandbox) {
        const http = yield* client
        const response = yield* HttpClientRequest.post("/v2/sandboxes").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            templateID: options.template,
            timeout: options.timeoutSeconds,
            autoPause: options.autoPause,
            ...(options.autoPause ? { autoResume: { enabled: true } } : {}),
            envVars: options.envVars,
            metadata: options.metadata,
            network: { allowPublicTraffic: false, rules: options.rules }
          }),
          http.execute,
          Effect.flatMap(okOrFail),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(CreatedSandbox)),
          Effect.mapError(failure("Creating a sandbox"))
        )
        return toAccess(response)
      })

      const connect = Effect.fn("E2B.connect")(function* (sandboxId: string, timeoutSeconds: number) {
        const http = yield* client
        const response = yield* HttpClientRequest.post(`/v2/sandboxes/${sandboxId}/connect`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ timeout: timeoutSeconds }),
          http.execute,
          Effect.mapError(failure("Resuming the sandbox"))
        )
        if (response.status === 404) return yield* new SandboxGone({ sandboxId })
        const body = yield* okOrFail(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(CreatedSandbox)),
          Effect.mapError(failure("Resuming the sandbox"))
        )
        return toAccess(body)
      })

      const info = Effect.fn("E2B.info")(function* (sandboxId: string) {
        const http = yield* client
        const response = yield* http
          .get(`/sandboxes/${sandboxId}`)
          .pipe(Effect.mapError(failure("Reading the sandbox")))
        if (response.status === 404) return Option.none()
        const body = yield* okOrFail(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(SandboxInfo)),
          Effect.mapError(failure("Reading the sandbox"))
        )
        return Option.some(body)
      })

      const setTimeout = Effect.fn("E2B.setTimeout")(function* (sandboxId: string, timeoutSeconds: number) {
        const http = yield* client
        const response = yield* HttpClientRequest.post(`/sandboxes/${sandboxId}/timeout`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ timeout: timeoutSeconds }),
          http.execute,
          Effect.mapError(failure("Setting the sandbox timeout"))
        )
        if (response.status === 404) return yield* new SandboxGone({ sandboxId })
        yield* okOrFail(response).pipe(Effect.mapError(failure("Setting the sandbox timeout")))
      })

      const updateRules = Effect.fn("E2B.updateRules")(function* (sandboxId: string, rules: NetworkRules) {
        const http = yield* client
        const response = yield* HttpClientRequest.put(`/sandboxes/${sandboxId}/network`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ rules }),
          http.execute,
          Effect.mapError(failure("Updating the sandbox's network rules"))
        )
        // Paused (or gone): nothing to update until it runs again.
        if (response.status === 404 || response.status === 409) return false
        yield* okOrFail(response).pipe(Effect.mapError(failure("Updating the sandbox's network rules")))
        return true
      })

      const pause = Effect.fn("E2B.pause")(function* (sandboxId: string) {
        const http = yield* client
        const response = yield* HttpClientRequest.post(`/sandboxes/${sandboxId}/pause`).pipe(
          HttpClientRequest.bodyJsonUnsafe({}),
          http.execute,
          Effect.mapError(failure("Pausing the sandbox"))
        )
        if (response.status === 404 || response.status === 409) return
        yield* okOrFail(response).pipe(Effect.mapError(failure("Pausing the sandbox")))
      })

      const kill = Effect.fn("E2B.kill")(function* (sandboxId: string) {
        const http = yield* client
        const response = yield* http
          .del(`/sandboxes/${sandboxId}`)
          .pipe(Effect.mapError(failure("Killing the sandbox")))
        if (response.status === 404) return
        yield* okOrFail(response).pipe(Effect.mapError(failure("Killing the sandbox")))
      })

      return E2B.of({ create, connect, info, setTimeout, updateRules, pause, kill })
    })
  )
}

const ErrorBody = Schema.Struct({ message: Schema.optionalKey(Schema.String) })

/** A 2xx response, or a failure carrying E2B's error message. */
export const okOrFail = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<HttpClientResponse.HttpClientResponse, string> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
        Effect.orElseSucceed(() => ({ message: undefined })),
        Effect.flatMap((body) =>
          Effect.fail(`HTTP ${response.status}${body.message === undefined ? "" : `: ${body.message}`}`)
        )
      )

export const describe = (cause: unknown): string =>
  typeof cause === "string"
    ? cause
    : cause instanceof Error
      ? cause.message
      : typeof cause === "object" && cause !== null && "message" in cause
        ? String((cause as { message: unknown }).message)
        : String(cause)
