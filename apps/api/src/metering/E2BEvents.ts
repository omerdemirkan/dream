/**
 * E2B's lifecycle events, as metering reads them: the webhook body E2B posts (snake_case) and the same events from
 * `GET /events/sandboxes` (camelCase at the top, snake_case inside `eventData`), both decoded into one
 * `LifecycleEvent`; and the API calls behind the backfill and the Worker's own webhook (`/events/webhooks`).
 * Verified against the live API on 2026-11-08 (docs/research/metering.md).
 */
import { SandboxMetadataKey, UpstreamFailure } from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ApiConfig, required } from "../Config.ts"
import { describe, okOrFail } from "../e2b/E2B.ts"
import { type MeterEvent, OperatorOwner } from "./Meter.ts"

/** The two events that end a billed run, and carry its `execution`. */
export const BilledTypes = ["sandbox.lifecycle.paused", "sandbox.lifecycle.killed"] as const

const Nullish = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

const Execution = Schema.Struct({
  /** Milliseconds. */
  execution_time: Schema.Finite,
  memory_mb: Schema.Finite,
  vcpu_count: Schema.Finite,
  started_at: Nullish(Schema.String)
})

const EventData = Schema.Struct({
  execution: Nullish(Execution),
  kill_reason: Nullish(Schema.String),
  pause_mode: Nullish(Schema.String),
  sandbox_metadata: Nullish(Schema.Record(Schema.String, Schema.String))
})

/** What E2B posts to a webhook. */
export const WebhookBody = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  timestamp: Schema.String,
  event_data: Nullish(EventData),
  sandbox_id: Schema.String,
  sandbox_execution_id: Nullish(Schema.String),
  sandbox_template_id: Nullish(Schema.String)
})

/** One event from `GET /events/sandboxes`. */
export const ApiEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  timestamp: Schema.String,
  eventData: Nullish(EventData),
  sandboxId: Schema.String,
  sandboxExecutionId: Nullish(Schema.String),
  sandboxTemplateId: Nullish(Schema.String)
})
const ApiEvents = Schema.Array(ApiEvent)

export interface LifecycleEvent {
  readonly id: string
  readonly type: string
  readonly timestamp: string
  readonly sandboxId: string
  readonly executionId?: string | undefined
  readonly templateId?: string | undefined
  readonly data: typeof EventData.Type
}

export const fromWebhook = (body: typeof WebhookBody.Type): LifecycleEvent => ({
  id: body.id,
  type: body.type,
  timestamp: body.timestamp,
  sandboxId: body.sandbox_id,
  executionId: body.sandbox_execution_id ?? undefined,
  templateId: body.sandbox_template_id ?? undefined,
  data: body.event_data ?? {}
})

export const fromApi = (event: typeof ApiEvent.Type): LifecycleEvent => ({
  id: event.id,
  type: event.type,
  timestamp: event.timestamp,
  sandboxId: event.sandboxId,
  executionId: event.sandboxExecutionId ?? undefined,
  templateId: event.sandboxTemplateId ?? undefined,
  data: event.eventData ?? {}
})

/** Whose a sandbox's run was, from the metadata Dream gives every sandbox (`Sandbox.ts`). */
export interface Attribution {
  readonly owner: string
  readonly project?: string | undefined
  readonly cause: "project" | "refresh" | "sign-in" | "dev" | "harness-check"
}

export const attribute = (metadata: Readonly<Record<string, string>>): Attribution => {
  const purpose = metadata[SandboxMetadataKey.purpose]
  const userId = metadata[SandboxMetadataKey.userId]
  const projectId = metadata[SandboxMetadataKey.projectId]
  if (purpose === "harness-check") return { owner: OperatorOwner, cause: "harness-check" }
  if (purpose === "dev") return { owner: OperatorOwner, cause: "dev" }
  if (purpose === "model-connect") return { owner: userId ?? OperatorOwner, cause: "sign-in" }
  if (projectId !== undefined) {
    return {
      owner: userId ?? OperatorOwner,
      project: projectId,
      cause: purpose === "refresh-donor" ? "refresh" : "project"
    }
  }
  return { owner: OperatorOwner, cause: "dev" }
}

/** The run a paused or killed event ends, or None for every other event (and one without `execution`). */
export const toMeterEvent = (event: LifecycleEvent): Option.Option<MeterEvent> => {
  const execution = event.data.execution
  const ended = event.type === BilledTypes[0] ? "paused" : event.type === BilledTypes[1] ? "killed" : undefined
  const at = DateTime.make(event.timestamp)
  if (ended === undefined || execution === undefined || execution === null || Option.isNone(at)) return Option.none()
  const who = attribute(event.data.sandbox_metadata ?? {})
  const optional = (key: string, value: string | null | undefined) =>
    value === undefined || value === null || value === "" ? {} : { [key]: value }
  return Option.some({
    id: `e2b:${event.id}`,
    owner: who.owner,
    meter: "sandbox_run",
    at: DateTime.toUtc(at.value),
    quantities: {
      ms: Math.max(0, execution.execution_time),
      vcpus: Math.max(0, execution.vcpu_count),
      memory_mb: Math.max(0, execution.memory_mb)
    },
    dimensions: {
      ...optional("project", who.project),
      payer: "dream",
      provider: "e2b",
      sandbox: event.sandboxId,
      ...optional("execution", event.executionId),
      ...optional("template", event.templateId),
      cause: who.cause,
      ended,
      ...optional("kill_reason", ended === "killed" ? event.data.kill_reason : undefined)
    }
  })
}

const Webhook = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  name: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
  events: Schema.optionalKey(Schema.Array(Schema.String))
})
export type E2BWebhook = typeof Webhook.Type

export interface WebhookSettings {
  readonly name: string
  readonly url: string
  readonly events: ReadonlyArray<string>
  readonly signatureSecret: Redacted.Redacted<string>
}

export class E2BEvents extends Context.Service<
  E2BEvents,
  {
    /** A page of the team's paused and killed events, newest first (E2B keeps them `events_ttl_days`, 7). */
    readonly billed: (offset: number, limit: number) => Effect.Effect<ReadonlyArray<LifecycleEvent>, UpstreamFailure>
    readonly webhooks: Effect.Effect<ReadonlyArray<E2BWebhook>, UpstreamFailure>
    readonly createWebhook: (settings: WebhookSettings) => Effect.Effect<E2BWebhook, UpstreamFailure>
    /** Updates the webhook; None if it's gone. */
    readonly updateWebhook: (
      id: string,
      settings: WebhookSettings
    ) => Effect.Effect<Option.Option<E2BWebhook>, UpstreamFailure>
    readonly deleteWebhook: (id: string) => Effect.Effect<void, UpstreamFailure>
  }
>()("@dream/api/metering/E2BEvents") {
  static readonly layer = Layer.effect(
    E2BEvents,
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

      const billed = Effect.fn("E2BEvents.billed")(function* (offset: number, limit: number) {
        const http = yield* client
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
        for (const type of BilledTypes) params.append("types", type)
        const events = yield* http
          .get(`/events/sandboxes?${params.toString()}`)
          .pipe(
            Effect.flatMap(okOrFail),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ApiEvents)),
            Effect.mapError(failure("Reading sandbox events"))
          )
        return events.map(fromApi)
      })

      const body = (settings: WebhookSettings) => ({
        name: settings.name,
        url: settings.url,
        events: settings.events,
        enabled: true,
        signatureSecret: Redacted.value(settings.signatureSecret)
      })

      const webhooks = Effect.gen(function* () {
        const http = yield* client
        return yield* http
          .get("/events/webhooks")
          .pipe(
            Effect.flatMap(okOrFail),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(Webhook))),
            Effect.mapError(failure("Listing webhooks"))
          )
      })

      const createWebhook = Effect.fn("E2BEvents.createWebhook")(function* (settings: WebhookSettings) {
        const http = yield* client
        return yield* HttpClientRequest.post("/events/webhooks").pipe(
          HttpClientRequest.bodyJsonUnsafe(body(settings)),
          http.execute,
          Effect.flatMap(okOrFail),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Webhook)),
          Effect.mapError(failure("Creating the webhook"))
        )
      })

      const updateWebhook = Effect.fn("E2BEvents.updateWebhook")(function* (id: string, settings: WebhookSettings) {
        const http = yield* client
        const response = yield* HttpClientRequest.patch(`/events/webhooks/${encodeURIComponent(id)}`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body(settings)),
          http.execute,
          Effect.mapError(failure("Updating the webhook"))
        )
        if (response.status === 404) return Option.none()
        yield* okOrFail(response).pipe(Effect.mapError(failure("Updating the webhook")))
        // What PATCH answers with isn't documented; the settings are what was asked for.
        const updated = yield* HttpClientResponse.schemaBodyJson(Webhook)(response).pipe(
          Effect.orElseSucceed((): E2BWebhook => ({ id, url: settings.url, events: settings.events }))
        )
        return Option.some(updated)
      })

      const deleteWebhook = Effect.fn("E2BEvents.deleteWebhook")(function* (id: string) {
        const http = yield* client
        const response = yield* http
          .del(`/events/webhooks/${encodeURIComponent(id)}`)
          .pipe(Effect.mapError(failure("Deleting the webhook")))
        if (response.status === 404) return
        yield* okOrFail(response).pipe(Effect.mapError(failure("Deleting the webhook")))
      })

      return E2BEvents.of({ billed, webhooks, createWebhook, updateWebhook, deleteWebhook })
    })
  )
}
