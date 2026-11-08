/**
 * Dream's usage meter: every cost Dream incurs for someone, recorded as it happens, one event per billable thing
 * (an E2B run, a browser session, a Mac session, an OpenAI call through the gateway, …). See docs/metering.md.
 *
 * Events form an append-only stream of immutable facts: a stable id (the idempotency key), the owner who caused
 * it, the meter it counts toward, when it happened, its raw quantities and the dimensions it can be grouped by. No
 * prices: the sink behind `Meter` decides what to do with an event. Today's sink (`MeterD1`) keeps it in D1 with an
 * estimate from the price book for the app to show; a billing platform would be another sink, rating events itself.
 * Code that meters depends only on this tag.
 */
import { Context, type Effect, Layer, Ref, Schema } from "effect"

/** Who an event belongs to when no person caused it: checks, template builds, throwaway sandboxes. */
export const OperatorOwner = "dream"

export const MeterName = Schema.Literals([
  /** One E2B run, from create or resume to pause or kill (`execution` on the lifecycle event). */
  "sandbox_run",
  /** One Browserbase session, once it ended. */
  "browser_session",
  /** One Namespace Mac, once it was destroyed. */
  "mac_session",
  /** One OpenAI call through Dream's gateway: an HTTP request, or one billed unit of a realtime session. */
  "openai_request",
  /** A day of media kept in R2 for a project (a gauge: one event per project per UTC day). */
  "storage_day",
  /** One email Dream sent on a project's behalf. */
  "email_sent"
])
export type MeterName = typeof MeterName.Type

const Quantity = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const MeterEvent = Schema.Struct({
  /** Derived from the source (E2B's event id, the session id, OpenAI's response id), so a retry records nothing. */
  id: Schema.String.check(Schema.isMinLength(1)),
  /** The Dream user id, or `OperatorOwner`. */
  owner: Schema.String.check(Schema.isMinLength(1)),
  meter: MeterName,
  /** When the cost was incurred: a run's end, a request's completion. */
  at: Schema.DateTimeUtc,
  /**
   * Raw amounts in their own units (milliseconds, tokens, bytes, characters). Never Dream's prices; the one amount
   * of money allowed is what a provider itself reported charging for the event (`cost_usd`), a fact of the event.
   */
  quantities: Schema.Record(Schema.String, Quantity),
  /** What the event can be grouped or filtered by: `project`, `payer`, `provider`, `model`, … */
  dimensions: Schema.Record(Schema.String, Schema.String)
})
export type MeterEvent = typeof MeterEvent.Type

export class Meter extends Context.Service<
  Meter,
  {
    /**
     * Records `events`; one whose `id` was already recorded is ignored. Never fails: metering must not break the
     * work it measures, so a sink's failure is logged.
     */
    readonly record: (events: ReadonlyArray<MeterEvent>) => Effect.Effect<void>
  }
>()("@dream/api/metering/Meter") {
  /** Keeps events in `log`, deduplicated like the real sinks, for tests to read back. */
  static readonly layerTest = (log: Ref.Ref<ReadonlyArray<MeterEvent>>) =>
    Layer.succeed(
      Meter,
      Meter.of({
        record: (events) =>
          Ref.update(log, (seen) => {
            const ids = new Set(seen.map((event) => event.id))
            const fresh = events.filter((event) => !ids.has(event.id) && ids.add(event.id))
            return [...seen, ...fresh]
          })
      })
    )
}
