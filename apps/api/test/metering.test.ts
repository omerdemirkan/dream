/**
 * The metering ledger: the price book, the D1 sink, E2B's webhook and backfill (against fakes, with the bodies E2B
 * sent the live probe), storage and the migration from `usage_events`, and the cost report the app and agent read.
 */
import { readFileSync } from "node:fs"
import type { EventId, ProjectId, UserId, WakeId } from "@dream/domain"
import { AgentEvent, Routes } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { Context, DateTime, Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Tokens } from "../src/auth/Tokens.ts"
import { route } from "../src/http/Router.ts"
import { fromApi, toMeterEvent } from "../src/metering/E2BEvents.ts"
import { E2BMetering, e2bSignature } from "../src/metering/E2BMetering.ts"
import { Meter, type MeterEvent } from "../src/metering/Meter.ts"
import { macMinutes, modelPrice, openaiUsd, price } from "../src/metering/Prices.ts"
import { rollUp, SandboxUsage } from "../src/metering/SandboxUsage.ts"
import { StorageMeter } from "../src/metering/Storage.ts"
import { SandboxWakes } from "../src/db/SandboxWakes.ts"
import { wakeReason } from "../src/project/SandboxManager.ts"
import { utf8 } from "../src/lib/Bytes.ts"
import { makeCloud } from "./support/Cloud.ts"

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const api = "https://api.dream.test"
const OWNER = "usr_owner" as UserId
const OTHER = "usr_other" as UserId
const PROJECT = "prj_mine" as ProjectId
const PROJECT_B = "prj_second" as ProjectId

const event = (overrides: Partial<MeterEvent> & Pick<MeterEvent, "meter">): MeterEvent => ({
  id: `test:${Math.random()}`,
  owner: OWNER,
  at: DateTime.nowUnsafe(),
  quantities: {},
  dimensions: { project: PROJECT, payer: "dream" },
  ...overrides
})

const close = (actual: number, expected: number, digits = 1e-9) => assert.closeTo(actual, expected, digits)

describe("the price book", () => {
  it("prices an E2B run by its size and time", () => {
    // An hour on 2 vCPUs and 4 GiB: 3600 × (2 × 0.000014 + 4 × 0.0000045).
    const priced = price(event({ meter: "sandbox_run", quantities: { ms: 3_600_000, vcpus: 2, memory_mb: 4096 } }))
    close(priced.usd, 3600 * (2 * 0.000014 + 4 * 0.0000045))
    close(priced.units, 1)
    assert.strictEqual(priced.center, "sandbox")
  })

  it("bills Browserbase's minimum minute and its proxy bytes", () => {
    const short = price(event({ meter: "browser_session", quantities: { ms: 5_000, proxy_bytes: 0 } }))
    assert.strictEqual(short.units, 1)
    close(short.usd, 0.002)
    const proxied = price(event({ meter: "browser_session", quantities: { ms: 90_000, proxy_bytes: 500_000_000 } }))
    assert.strictEqual(proxied.units, 2)
    close(proxied.usd, 0.004 + 6)
  })

  it("rounds a Mac's last 15 seconds down, and prices it by shape", () => {
    assert.strictEqual(macMinutes(130_000), 2)
    assert.strictEqual(macMinutes(140_000), 3)
    assert.strictEqual(macMinutes(1_000), 1)
    const mac = price(event({ meter: "mac_session", quantities: { ms: 600_000, vcpus: 4, memory_mb: 7168 } }))
    close(mac.usd, 10 * 0.06)
    const big = price(event({ meter: "mac_session", quantities: { ms: 600_000, vcpus: 8, memory_mb: 14336 } }))
    close(big.usd, 10 * 0.12)
  })

  it("splits OpenAI tokens the way OpenAI nests them", () => {
    const sol = modelPrice("gpt-6.1-sol")!
    // 1M input of which 400k cached, 100k output: 0.6 × 2 + 0.4 × 0.1 + 0.1 × 10.
    close(openaiUsd(sol, { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000 }), 2.24)
    // Flex is half.
    close(openaiUsd(sol, { input_tokens: 1_000_000 }, "flex"), 1)
    // Realtime: audio in and out at their own prices, cached audio apart, text the rest.
    const realtime = modelPrice("gpt-realtime-2.1")!
    const usd = openaiUsd(realtime, {
      input_tokens: 1_000_000,
      input_audio_tokens: 600_000,
      cached_input_tokens: 300_000,
      cached_audio_tokens: 200_000,
      output_tokens: 500_000,
      output_audio_tokens: 400_000
    })
    // text in 1M − 600k audio − 100k cached text = 300k × 4; cached text 100k × 0.4; audio 400k × 32;
    // cached audio 200k × 0.4; text out 100k × 24; audio out 400k × 64.
    close(usd, 1.2 + 0.04 + 12.8 + 0.08 + 2.4 + 25.6)
    close(openaiUsd(modelPrice("tts-1")!, { characters: 1_000_000 }), 15)
    close(openaiUsd(modelPrice("whisper-1")!, { audio_ms: 120_000 }), 0.012)
    close(openaiUsd(modelPrice("gpt-live-1")!, { session_ms: 60_000 }), 0.05)
    close(openaiUsd(sol, { web_search_calls: 3 }), 0.03)
  })

  it("knows a dated snapshot, and records a model it doesn't know at 0", () => {
    assert.deepStrictEqual(modelPrice("gpt-6.1-sol-2026-10-01"), modelPrice("gpt-6.1-sol"))
    const unknown = price(
      event({ meter: "model_request", quantities: { input_tokens: 1000 }, dimensions: { model: "gpt-9-nova" } })
    )
    assert.strictEqual(unknown.usd, 0)
    assert.strictEqual(unknown.units, 1)
    assert.strictEqual(unknown.unknownModel, "gpt-9-nova")
    // A cost the provider reported is the event's cost, known model or not.
    const reported = price(
      event({
        meter: "model_request",
        quantities: { input_tokens: 1_000_000, cost_usd: 0.4321 },
        dimensions: { model: "anthropic/some-model" }
      })
    )
    assert.strictEqual(reported.usd, 0.4321)
    assert.isUndefined(reported.unknownModel)
    const person = price(
      event({ meter: "model_request", dimensions: { model: "gpt-6-luna", payer: "person" }, quantities: {} })
    )
    assert.strictEqual(person.payer, "person")
  })
})

// What E2B sent the live probe on 2026-11-08 (ids shortened), as a webhook and as `/events/sandboxes` has it.
const webhookBody = (id: string, metadata: Record<string, string>, type = "sandbox.lifecycle.paused") => ({
  id,
  version: "v2",
  type,
  timestamp: "2026-11-08T10:15:02.123456Z",
  event_category: "lifecycle",
  event_label: type.split(".").pop(),
  event_data: {
    execution: { execution_time: 125_000, memory_mb: 4096, started_at: "2026-11-08T10:12:57Z", vcpu_count: 2 },
    pause_mode: "full",
    sandbox_metadata: metadata
  },
  sandbox_id: "isb1",
  sandbox_execution_id: "exe1",
  sandbox_template_id: "tpl1",
  sandbox_build_id: "bld1",
  sandbox_team_id: "team1",
  events_ttl_days: 7
})

const apiEvent = (id: string, timestamp: string, metadata: Record<string, string>, type = "sandbox.lifecycle.killed") =>
  fromApi({
    id,
    type,
    timestamp,
    sandboxId: `sbx-${id}`,
    sandboxExecutionId: `exe-${id}`,
    sandboxTemplateId: "tpl1",
    eventData: {
      execution: { execution_time: 60_000, memory_mb: 512, vcpu_count: 2, started_at: timestamp },
      kill_reason: "request",
      sandbox_metadata: metadata
    }
  })

const seed = (cloud: Cloud) => {
  const now = new Date().toISOString()
  cloud.db.exec(`
    INSERT INTO users (id, email, name, created_at) VALUES
      ('${OWNER}', 'omer@example.com', 'Omer', '${now}'),
      ('${OTHER}', 'other@example.com', NULL, '${now}');
    INSERT INTO projects (id, owner_id, title, icon, idea, harness, phase, slug, host, public_url, created_at, updated_at)
    VALUES
      ('${PROJECT}', '${OWNER}', 'Fare watch', 'airplane', 'idea', 'claude-code', 'building', 'fare', 'fare-1.dream.test',
        'https://fare-1.dream.test', '${now}', '${now}'),
      ('${PROJECT_B}', '${OWNER}', 'Second', NULL, 'idea', 'claude-code', 'building', 'sec', 'sec-1.dream.test',
        'https://sec-1.dream.test', '${now}', '${now}');`)
}

const send = (cloud: Cloud, path: string, init: RequestInit = {}) =>
  Effect.gen(function* () {
    const raw = new Request(`${api}${path}`, init)
    const response = yield* route(raw).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
      Effect.provide(Layer.succeedContext(cloud.workerContext))
    )
    const web = HttpServerResponse.toWeb(response)
    return { status: web.status, body: yield* Effect.promise(() => web.text()) }
  })

const rows = (cloud: Cloud) =>
  cloud.db.prepare("SELECT * FROM meter_events ORDER BY id").all() as Array<Record<string, unknown>>

const register = (cloud: Cloud, query = "") =>
  send(cloud, `${Routes.meteringE2bWebhook}${query}`, {
    method: "POST",
    headers: { "x-dream-dev-secret": "dev-secret" }
  })

/** Posts `body` signed as E2B signs it, with the secret the fake E2B was last given. */
/** E2B's signature, computed apart from the code under test: base64 SHA-256, padding stripped. */
const sign = (text: string) =>
  Effect.promise(async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)))
    return btoa(String.fromCharCode(...digest)).replace(/=+$/, "")
  })

const deliver = (cloud: Cloud, body: unknown, secret?: string) =>
  Effect.gen(function* () {
    const raw = JSON.stringify(body)
    const key = secret ?? [...cloud.world.e2bWebhooks.values()][0]!.secret
    const signature = yield* sign(key + raw)
    return yield* send(cloud, Routes.e2bWebhook, {
      method: "POST",
      headers: { "content-type": "application/json", "e2b-signature": signature, "e2b-signature-version": "v1" },
      body: raw
    })
  })

describe("E2B sandbox time", () => {
  it.effect("signs like E2B: base64 SHA-256 of the secret and the raw body, unpadded", () =>
    Effect.gen(function* () {
      const expected = yield* sign('s3cret{"a":1}')
      assert.notInclude(expected, "=")
      assert.strictEqual(yield* e2bSignature("s3cret", utf8('{"a":1}')), expected)
    })
  )

  it.effect("registers its webhook, verifies deliveries, and records each billed run once", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      seed(cloud)
      assert.strictEqual((yield* register(cloud)).status, 200)
      const [webhook] = [...cloud.world.e2bWebhooks.values()]
      assert.strictEqual(webhook?.url, `${api}${Routes.e2bWebhook}`)
      assert.deepStrictEqual(webhook?.events, ["sandbox.lifecycle.paused", "sandbox.lifecycle.killed"])
      // The secret stays sealed in D1; the route never shows it.
      const stored = cloud.db.prepare("SELECT * FROM meter_webhooks").all()[0] as Record<string, string>
      assert.notInclude(JSON.stringify(stored), webhook!.secret)

      const body = webhookBody("evt-1", { projectId: PROJECT, userId: OWNER })
      assert.strictEqual((yield* deliver(cloud, body)).status, 204)
      assert.strictEqual((yield* deliver(cloud, body)).status, 204)
      const recorded = rows(cloud)
      assert.strictEqual(recorded.length, 1)
      const row = recorded[0]!
      assert.strictEqual(row.id, "e2b:evt-1")
      assert.strictEqual(row.owner, OWNER)
      assert.strictEqual(row.project_id, PROJECT)
      assert.strictEqual(row.meter, "sandbox_run")
      assert.deepStrictEqual(JSON.parse(String(row.quantities_json)), { ms: 125_000, vcpus: 2, memory_mb: 4096 })
      assert.deepStrictEqual(JSON.parse(String(row.dimensions_json)), {
        project: PROJECT,
        payer: "dream",
        provider: "e2b",
        sandbox: "isb1",
        execution: "exe1",
        template: "tpl1",
        cause: "project",
        ended: "paused"
      })
      close(Number(row.cost_usd), 125 * (2 * 0.000014 + 4 * 0.0000045))

      // Wrong secret, no signature: refused. A created event is fine and records nothing.
      assert.strictEqual((yield* deliver(cloud, webhookBody("evt-2", {}), "wrong")).status, 401)
      const unsigned = yield* send(cloud, Routes.e2bWebhook, { method: "POST", body: JSON.stringify(body) })
      assert.strictEqual(unsigned.status, 401)
      const created = { ...webhookBody("evt-3", {}, "sandbox.lifecycle.created"), event_data: { sandbox_metadata: {} } }
      assert.strictEqual((yield* deliver(cloud, created)).status, 204)
      assert.strictEqual((yield* deliver(cloud, { nonsense: true })).status, 202)
      assert.strictEqual(rows(cloud).length, 1)

      // Rotating: the webhook is updated, not duplicated, and a delivery signed with the old secret still counts.
      const old = webhook!.secret
      assert.strictEqual((yield* register(cloud)).status, 200)
      assert.strictEqual(cloud.world.e2bWebhooks.size, 1)
      assert.notStrictEqual([...cloud.world.e2bWebhooks.values()][0]!.secret, old)
      assert.strictEqual((yield* deliver(cloud, webhookBody("evt-4", {}), old)).status, 204)
      assert.strictEqual((yield* deliver(cloud, webhookBody("evt-5", {}))).status, 204)
      assert.strictEqual(rows(cloud).length, 3)

      // A rotation E2B refuses, retried: E2B still signs with the secret it has, so that one keeps verifying.
      const kept = [...cloud.world.e2bWebhooks.values()][0]!.secret
      cloud.world.e2bWebhookUpdateFails = true
      assert.notStrictEqual((yield* register(cloud)).status, 200)
      assert.notStrictEqual((yield* register(cloud)).status, 200)
      assert.strictEqual((yield* deliver(cloud, webhookBody("evt-6", {}), kept)).status, 204)
      assert.strictEqual(rows(cloud).length, 4)
      yield* cloud.close
    })
  )

  it("attributes each kind of sandbox from its metadata", () => {
    const owner = (metadata: Record<string, string>) => {
      const run = toMeterEvent(apiEvent("x", "2026-11-08T10:00:00Z", metadata))
      assert.isTrue(run._tag === "Some")
      return run._tag === "Some" ? [run.value.owner, run.value.dimensions.project, run.value.dimensions.cause] : []
    }
    assert.deepStrictEqual(owner({ projectId: PROJECT, userId: OWNER }), [OWNER, PROJECT, "project"])
    assert.deepStrictEqual(owner({ projectId: PROJECT, userId: OWNER, purpose: "refresh-donor" }), [
      OWNER,
      PROJECT,
      "refresh"
    ])
    assert.deepStrictEqual(owner({ purpose: "model-connect", userId: OWNER, connectionId: "c" }), [
      OWNER,
      undefined,
      "sign-in"
    ])
    assert.deepStrictEqual(owner({ purpose: "harness-check", script: "harness-check" }), [
      "dream",
      undefined,
      "harness-check"
    ])
    assert.deepStrictEqual(owner({ purpose: "dev", script: "smoke" }), ["dream", undefined, "dev"])
    assert.deepStrictEqual(owner({}), ["dream", undefined, "dev"])
    const killed = toMeterEvent(apiEvent("k", "2026-11-08T10:00:00Z", {}))
    assert.strictEqual(killed._tag === "Some" && killed.value.dimensions.kill_reason, "request")
  })

  it.effect("backfills what the webhook missed, back to where it was asked, by the same ids", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      seed(cloud)
      const metering = Context.get(cloud.workerContext, E2BMetering)
      const now = Date.now()
      const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString()
      // 250 runs, newest first, one every 10 minutes: about 41 hours.
      cloud.world.e2bEvents = Array.from({ length: 250 }, (_, i) =>
        apiEvent(`bf-${i}`, iso(i / 6), { projectId: PROJECT, userId: OWNER })
      )
      // The webhook got the newest one already.
      const newest = toMeterEvent(cloud.world.e2bEvents[0]!)
      if (newest._tag === "Some") yield* Context.get(cloud.workerContext, Meter).record([newest.value])
      const result = yield* metering.backfill(DateTime.makeUnsafe(now - 25 * 3_600_000))
      // The second page still reaches into the window, so it reads a third, which is short: the end.
      assert.strictEqual(result.read, 250)
      assert.deepStrictEqual(cloud.world.e2bEventPages, [0, 100, 200])
      // Every run of the last 25 hours (i / 6 ≤ 25: i ≤ 150), once.
      assert.strictEqual(rows(cloud).length, 151)
      yield* metering.backfill(DateTime.makeUnsafe(now - 25 * 3_600_000))
      assert.strictEqual(rows(cloud).length, 151)
      yield* cloud.close
    })
  )
})

describe("storage and the old ledger", () => {
  it.live("records yesterday's stored bytes once per project", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      seed(cloud)
      const now = new Date().toISOString()
      cloud.db.exec(`
        INSERT INTO media (id, project_id, user_id, object_key, ref_json, uploaded_at, created_at) VALUES
          ('med_1', '${PROJECT}', '${OWNER}', 'k1', '{"sizeBytes": 3000000000}', '${now}', '${now}'),
          ('med_2', '${PROJECT}', '${OWNER}', 'k2', '{"sizeBytes": 999}', NULL, '${now}');
        INSERT INTO attachments (id, user_id, project_id, object_key, ref_json, uploaded_at, created_at) VALUES
          ('med_3', '${OWNER}', '${PROJECT}', 'k3', '{"sizeBytes": 1000000000}', '${now}', '${now}');`)
      const storage = Context.get(cloud.workerContext, StorageMeter)
      yield* storage.recordDay
      yield* storage.recordDay
      const recorded = rows(cloud)
      assert.strictEqual(recorded.length, 1)
      const yesterday = DateTime.formatIsoDate(DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }))
      assert.strictEqual(recorded[0]!.id, `r2:${PROJECT}:${yesterday}`)
      assert.deepStrictEqual(JSON.parse(String(recorded[0]!.quantities_json)), { bytes: 4_000_000_000 })
      // 4 GB for one day of the month, at $0.015 a GB-month.
      assert.isTrue(Number(recorded[0]!.cost_usd) > 0.0019 && Number(recorded[0]!.cost_usd) < 0.0021)
      yield* cloud.close
    })
  )

  it.effect("copies usage_events over, leaving the last week's sandbox estimates to E2B", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      seed(cloud)
      const old = new Date(Date.now() - 10 * 86_400_000).toISOString()
      const recent = new Date(Date.now() - 86_400_000).toISOString()
      cloud.db.exec(`
        INSERT INTO usage_events (id, project_id, user_id, kind, ref, started_at, ended_at, minutes, created_at) VALUES
          ('use_b', '${PROJECT}', '${OWNER}', 'browser', 'bb1', '${old}', '${old}', 4, '${old}'),
          ('use_m', '${PROJECT}', '${OWNER}', 'mac', 'mac1', '${recent}', '${recent}', 10, '${recent}'),
          ('use_s1', '${PROJECT}', '${OWNER}', 'sandbox', 'sbx', '${old}', '${old}', 60, '${old}'),
          ('use_s2', '${PROJECT}', '${OWNER}', 'sandbox', 'sbx', '${recent}', '${recent}', 60, '${recent}');`)
      const migration = readFileSync(new URL("../migrations/0016_meter_events.sql", import.meta.url), "utf8")
      cloud.db.exec(migration.slice(migration.indexOf("INSERT INTO meter_events")))
      const copied = rows(cloud)
      assert.deepStrictEqual(
        copied.map((row) => row.id),
        ["browserbase:bb1", "namespace:mac1", "usage:use_s1"]
      )
      close(Number(copied[0]!.cost_usd), 0.008)
      close(Number(copied[1]!.cost_usd), 0.6)
      // The old sandbox hour, on the 4 vCPU / 8 GB size, priced like the book would.
      const priced = price({
        id: "x",
        owner: OWNER,
        meter: "sandbox_run",
        at: DateTime.nowUnsafe(),
        quantities: JSON.parse(String(copied[2]!.quantities_json)),
        dimensions: {}
      })
      close(Number(copied[2]!.cost_usd), priced.usd)
      close(Number(copied[2]!.units), 1)
      assert.strictEqual(JSON.parse(String(copied[2]!.dimensions_json)).estimated, "true")
      yield* cloud.close
    })
  )
})

describe("the cost report", () => {
  const signIn = (cloud: Cloud, id: UserId, email: string) =>
    Effect.gen(function* () {
      const tokens = Context.get(cloud.workerContext, Tokens)
      cloud.session.token = Redacted.value(yield* tokens.session({ id, email }))
    })

  const recordAll = (cloud: Cloud, events: ReadonlyArray<MeterEvent>) =>
    Context.get(cloud.workerContext, Meter).record(events)

  const ledger = (now: DateTime.Utc): ReadonlyArray<MeterEvent> => {
    const lastMonth = DateTime.subtract(DateTime.startOf(now, "month"), { days: 3 })
    return [
      // This month: an hour of sandbox, a browser, OpenAI on Dream and on their own key, a sign-in sandbox.
      event({ id: "a", meter: "sandbox_run", at: now, quantities: { ms: 3_600_000, vcpus: 2, memory_mb: 4096 } }),
      event({ id: "b", meter: "browser_session", at: now, quantities: { ms: 600_000 } }),
      event({
        id: "c",
        meter: "model_request",
        at: now,
        quantities: { input_tokens: 1_000_000, output_tokens: 100_000 },
        dimensions: { project: PROJECT, payer: "dream", model: "gpt-6.1-sol" }
      }),
      event({
        id: "d",
        meter: "model_request",
        at: now,
        quantities: { input_tokens: 1_000_000 },
        dimensions: { project: PROJECT, payer: "person", model: "gpt-6.1-sol" }
      }),
      event({
        id: "e",
        meter: "sandbox_run",
        at: now,
        quantities: { ms: 60_000, vcpus: 2, memory_mb: 512 },
        dimensions: { payer: "dream", cause: "sign-in" }
      }),
      event({
        id: "f",
        meter: "sandbox_run",
        at: now,
        quantities: { ms: 3_600_000, vcpus: 2, memory_mb: 4096 },
        dimensions: { project: PROJECT_B, payer: "dream" }
      }),
      // Last month.
      event({ id: "g", meter: "mac_session", at: lastMonth, quantities: { ms: 600_000, vcpus: 4 } }),
      // Someone else's, and Dream's own.
      event({
        id: "h",
        owner: OTHER,
        meter: "browser_session",
        at: now,
        dimensions: { project: "prj_x", payer: "dream" }
      }),
      event({
        id: "i",
        owner: "dream",
        meter: "sandbox_run",
        at: now,
        quantities: { ms: 3_600_000, vcpus: 2, memory_mb: 4096 },
        dimensions: { payer: "dream", cause: "harness-check" }
      })
    ]
  }

  const hour = 3600 * (2 * 0.000014 + 4 * 0.0000045)

  it.live("sums a project's month by center, its models, last month and the last 30 days", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      seed(cloud)
      const now = yield* DateTime.now
      yield* recordAll(cloud, ledger(now))
      yield* signIn(cloud, OWNER, "omer@example.com")
      const costs = yield* cloud.phone.GetProjectCosts({ projectId: PROJECT })
      // Dream's: an hour of sandbox, 10 browser minutes, the Dream-paid call (2 + 1).
      close(costs.month.usd, Math.round((hour + 0.02 + 3) * 10_000) / 10_000, 1e-4)
      assert.deepStrictEqual(
        costs.month.lines.map((line) => [line.center, line.payer, line.unit]),
        [
          ["models", "dream", "request"],
          ["models", "person", "request"],
          ["sandbox", "dream", "hour"],
          ["browser", "dream", "minute"]
        ]
      )
      assert.strictEqual(costs.month.lines.find((line) => line.center === "browser")?.quantity, 10)
      assert.deepStrictEqual(
        costs.month.models.map((model) => [model.model, model.payer, model.usd, model.requests]),
        [
          ["gpt-6.1-sol", "dream", 3, 1],
          ["gpt-6.1-sol", "person", 2, 1]
        ]
      )
      close(costs.lastMonth.usd, 0.6)
      assert.strictEqual(costs.days.length, 30)
      assert.strictEqual(costs.days.at(-1)?.day, DateTime.formatIsoDate(now))
      close(costs.days.at(-1)!.usd, costs.month.usd, 1e-4)

      // Not theirs: NotFound.
      yield* signIn(cloud, OTHER, "other@example.com")
      const refused = yield* Effect.flip(cloud.phone.GetProjectCosts({ projectId: PROJECT }))
      assert.strictEqual(refused._tag, "NotFound")
      yield* cloud.close
    })
  )

  it.live("sums their account by project, with what no project caused, and everyone's for an operator", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud({ operators: ["omer@example.com"] })
      seed(cloud)
      yield* recordAll(cloud, ledger(yield* DateTime.now))
      yield* signIn(cloud, OWNER, "omer@example.com")
      const account = yield* cloud.phone.GetAccountCosts()
      assert.deepStrictEqual(
        account.projects.map((project) => [project.projectId, project.title, project.icon, project.personUsd]),
        [
          [PROJECT, "Fare watch", "airplane", 2],
          [PROJECT_B, "Second", undefined, undefined]
        ]
      )
      assert.deepStrictEqual(
        account.unattributed.map((line) => line.center),
        ["sandbox"]
      )
      const everyone = account.everyone!
      assert.deepStrictEqual(
        everyone.people.map((person) => [person.userId, person.name, person.projects]),
        [
          [OWNER, "Omer", 2],
          [OTHER, "other@example.com", 1]
        ]
      )
      assert.deepStrictEqual(
        everyone.overhead.map((line) => [line.center, line.quantity]),
        [["sandbox", 1]]
      )
      close(everyone.month.usd, account.month.usd + 0.002 + Math.round(hour * 10_000) / 10_000, 1e-3)

      // Not an operator: no `everyone`.
      yield* signIn(cloud, OTHER, "other@example.com")
      const theirs = yield* cloud.phone.GetAccountCosts()
      assert.isUndefined(theirs.everyone)
      assert.deepStrictEqual(
        theirs.projects.map((project) => [project.projectId, project.title, project.archived]),
        [["prj_x", "Deleted project", true]]
      )
      yield* cloud.close
    })
  )
})

describe("resource telemetry", () => {
  const sample = (atSeconds: number, cpu: number, memMb: number) => ({
    timestampUnix: atSeconds,
    cpuCount: 2,
    cpuUsedPct: cpu,
    memUsed: memMb * 1024 * 1024,
    memTotal: 4096 * 1024 * 1024,
    diskUsed: 6000 * 1024 * 1024,
    diskTotal: 17000 * 1024 * 1024
  })
  const listed = (sandboxID: string, state: string, metadata: Record<string, string>, endAt?: string) => ({
    sandboxID,
    state,
    cpuCount: 2,
    memoryMB: 4096,
    metadata,
    ...(endAt === undefined ? {} : { endAt })
  })

  it("rolls samples up per UTC hour", () => {
    const hour = Date.parse("2026-11-08T10:00:00Z") / 1000
    const hours = rollUp([sample(hour + 60, 10, 500), sample(hour + 120, 30, 900), sample(hour + 3600, 80, 3000)])
    assert.deepStrictEqual(
      hours.map((h) => [h.hour, h.samples, h.cpuAvgPct, h.cpuMaxPct, h.memAvgMb, h.memMaxMb]),
      [
        ["2026-11-08T10:00:00.000Z", 2, 20, 30, 700, 900],
        ["2026-11-08T11:00:00.000Z", 1, 80, 80, 3000, 3000]
      ]
    )
    close(hours[0]!.diskTotalMb, 17000)
  })

  it.live("keeps each recent sandbox's hours, completing an hour read while it was going", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const usage = Context.get(cloud.workerContext, SandboxUsage)
      const nowS = Math.floor(Date.now() / 1000)
      const hourS = Math.floor(nowS / 3600) * 3600
      cloud.world.e2bListed = [
        listed("sbx-run", "running", { projectId: PROJECT, userId: OWNER }),
        listed("sbx-dev", "paused", { purpose: "dev", script: "smoke" }, new Date().toISOString()),
        listed("sbx-old", "paused", { projectId: PROJECT_B, userId: OWNER }, "2026-01-01T00:00:00Z")
      ]
      cloud.world.e2bMetrics.set("sbx-run", [sample(hourS - 3000, 40, 1200), sample(hourS + 1, 5, 800)])
      cloud.world.e2bMetrics.set("sbx-dev", [sample(hourS + 2, 90, 3900)])
      yield* usage.hourly
      // A sandbox paused long ago didn't run since: its metrics aren't read.
      assert.deepStrictEqual(cloud.world.e2bMetricReads.map((read) => read.sandboxId).sort(), ["sbx-dev", "sbx-run"])
      assert.strictEqual(cloud.world.e2bMetricReads[0]!.start, hourS - 7200)
      const read = () =>
        cloud.db
          .prepare(
            "SELECT sandbox_id, hour, project_id, cause, samples, cpu_max_pct, mem_max_mb FROM sandbox_usage ORDER BY sandbox_id, hour"
          )
          .all() as Array<Record<string, unknown>>
      assert.deepStrictEqual(
        read().map((row) => [row.sandbox_id, row.project_id, row.cause, row.samples, row.cpu_max_pct, row.mem_max_mb]),
        [
          ["sbx-dev", null, "dev", 1, 90, 3900],
          ["sbx-run", PROJECT, "project", 1, 40, 1200],
          ["sbx-run", PROJECT, "project", 1, 5, 800]
        ]
      )
      // The hour went on: the next run replaces it with the fuller reading.
      cloud.world.e2bMetrics.get("sbx-run")!.push(sample(hourS + 2, 70, 2000))
      yield* usage.hourly
      const current = read()
        .filter((row) => row.sandbox_id === "sbx-run")
        .at(-1)!
      assert.deepStrictEqual([current.samples, current.cpu_max_pct, current.mem_max_mb], [2, 70, 2000])
      yield* cloud.close
    })
  )

  it.effect("notes a sandbox's wakes at most once a minute per reason, and forgets them after 30 days", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const wakes = Context.get(cloud.workerContext, SandboxWakes)
      yield* TestClock.setTime(Date.parse("2026-11-08T10:00:00Z"))
      yield* wakes.record(PROJECT, "visit")
      yield* wakes.record(PROJECT, "visit")
      yield* wakes.record(PROJECT, "delivery", "UserMessage")
      yield* wakes.record(PROJECT_B, "visit")
      yield* TestClock.adjust("61 seconds")
      yield* wakes.record(PROJECT, "visit")
      const read = () =>
        cloud.db
          .prepare("SELECT project_id, reason, detail, at FROM sandbox_wakes ORDER BY at, project_id, reason")
          .all() as Array<Record<string, unknown>>
      assert.deepStrictEqual(
        read().map((row) => [row.project_id, row.reason, row.detail]),
        [
          [PROJECT, "delivery", "UserMessage"],
          [PROJECT, "visit", null],
          [PROJECT_B, "visit", null],
          [PROJECT, "visit", null]
        ]
      )
      yield* TestClock.adjust("31 days")
      yield* wakes.record(PROJECT, "relay")
      yield* wakes.prune
      assert.deepStrictEqual(
        read().map((row) => row.reason),
        ["relay"]
      )
      yield* cloud.close
    })
  )

  it("names what a delivery wakes the sandbox for", () => {
    const at = DateTime.makeUnsafe("2026-11-08T10:00:00Z")
    const fields = { id: "evt_1" as EventId, at }
    const run = AgentEvent.cases.WakeDue.make({
      ...fields,
      wakeId: "wak_1" as WakeId,
      why: "check",
      run: { command: "x" }
    })
    const task = AgentEvent.cases.WakeDue.make({
      ...fields,
      wakeId: "wak_2" as WakeId,
      why: "digest",
      task: { brief: "b", model: "m", effort: "low" }
    })
    const alert = AgentEvent.cases.Alert.make({ ...fields, reason: "boom" })
    assert.deepStrictEqual(wakeReason([run, run]), ["wake-run"])
    assert.deepStrictEqual(wakeReason([task]), ["wake-task"])
    assert.deepStrictEqual(wakeReason([run, alert, alert]), ["delivery", "Alert,WakeDue"])
  })
})
