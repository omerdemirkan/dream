/**
 * Browserbase: recorded Chrome sessions for the agent. The connect URL embeds
 * its own signing key and the live-view URL its own token, so the sandbox
 * never sees the API key. Recordings are MP4 exports, available once a
 * session has ended (verified 2026-11-04; the rrweb API is gone).
 */
import { UpstreamFailure } from "@dream/domain"
import { Context, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ApiConfig, required } from "../Config.ts"
import { describe, okOrFail } from "../e2b/E2B.ts"

const base = "https://api.browserbase.com"

const Session = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  connectUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  startedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  endedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Bytes through Browserbase's proxies, billed per GB. */
  proxyBytes: Schema.optionalKey(Schema.NullOr(Schema.Finite))
})
export type BrowserbaseSession = typeof Session.Type

const Debug = Schema.Struct({ debuggerFullscreenUrl: Schema.String })

const Downloads = Schema.Struct({
  downloads: Schema.Array(
    Schema.Struct({
      pageId: Schema.optionalKey(Schema.String),
      status: Schema.String,
      downloadUrl: Schema.optionalKey(Schema.NullOr(Schema.String))
    })
  )
})

export type RecordingResult =
  | { readonly _tag: "Ready"; readonly url: string }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Failed" }

export class Browserbase extends Context.Service<
  Browserbase,
  {
    readonly create: (
      metadata: Readonly<Record<string, string>>
    ) => Effect.Effect<
      { readonly session: BrowserbaseSession; readonly connectUrl: string; readonly liveViewUrl: string },
      UpstreamFailure
    >
    readonly get: (id: string) => Effect.Effect<BrowserbaseSession, UpstreamFailure>
    readonly release: (id: string) => Effect.Effect<BrowserbaseSession, UpstreamFailure>
    /** Asks for the MP4 and waits briefly for it. */
    readonly recording: (id: string) => Effect.Effect<RecordingResult, UpstreamFailure>
  }
>()("@dream/api/Browserbase") {
  static readonly layer = Layer.effect(
    Browserbase,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const http = yield* HttpClient.HttpClient

      const client = Effect.map(required(config.browserbaseApiKey, "Browserbase", "BROWSERBASE_API_KEY"), (key) =>
        http.pipe(
          HttpClient.mapRequest((request) =>
            request.pipe(
              HttpClientRequest.prependUrl(base),
              HttpClientRequest.setHeader("X-BB-API-Key", Redacted.value(key)),
              HttpClientRequest.acceptJson
            )
          )
        )
      )

      const failure = (what: string) => (cause: unknown) =>
        new UpstreamFailure({ service: "Browserbase", message: `${what} failed: ${describe(cause)}` })

      const json = <S extends Schema.Codec<any, any, never, never>>(
        what: string,
        request: HttpClientRequest.HttpClientRequest,
        schema: S
      ) =>
        Effect.flatMap(client, (c) =>
          c
            .execute(request)
            .pipe(
              Effect.flatMap(okOrFail),
              Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
              Effect.mapError(failure(what))
            )
        )

      const create = Effect.fn("Browserbase.create")(function* (metadata: Readonly<Record<string, string>>) {
        const session = yield* json(
          "Starting a browser",
          HttpClientRequest.post("/v1/sessions").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              ...Option.match(config.browserbaseProjectId, {
                onNone: () => ({}),
                onSome: (projectId) => ({ projectId })
              }),
              timeout: 3600,
              browserSettings: { recordSession: true, logSession: true },
              userMetadata: metadata
            })
          ),
          Session
        )
        if (session.connectUrl === undefined || session.connectUrl === null) {
          return yield* failure("Starting a browser")("no connect URL in the response")
        }
        const debug = yield* json(
          "Getting the live view",
          HttpClientRequest.get(`/v1/sessions/${session.id}/debug`).pipe(
            HttpClientRequest.setUrlParams({ expiresIn: 21600 })
          ),
          Debug
        )
        return { session, connectUrl: session.connectUrl, liveViewUrl: debug.debuggerFullscreenUrl }
      })

      const get = (id: string) =>
        json("Reading the browser session", HttpClientRequest.get(`/v1/sessions/${id}`), Session)

      const release = (id: string) =>
        json(
          "Stopping the browser",
          HttpClientRequest.post(`/v1/sessions/${id}`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ status: "REQUEST_RELEASE" })
          ),
          Session
        )

      const recording = Effect.fn("Browserbase.recording")(function* (id: string) {
        const path = `/v1/sessions/${id}/recording/downloads`
        const current = yield* json("Checking the recording", HttpClientRequest.get(path), Downloads)
        if (current.downloads.length === 0 || current.downloads.every((d) => d.status === "NOT_REQUESTED")) {
          yield* json(
            "Requesting the recording",
            HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe({})),
            Downloads
          )
        }
        const poll = json("Checking the recording", HttpClientRequest.get(path), Downloads).pipe(
          Effect.map((body): RecordingResult => {
            const first = body.downloads[0]
            if (first?.status === "COMPLETED" && first.downloadUrl) return { _tag: "Ready", url: first.downloadUrl }
            if (first?.status === "FAILED") return { _tag: "Failed" }
            return { _tag: "Pending" }
          })
        )
        return yield* poll.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (result) => result._tag !== "Pending",
            times: 12
          })
        )
      })

      return Browserbase.of({ create, get, release, recording })
    })
  )
}
