/**
 * Checks Dream's E2B metering against the real E2B, with a throwaway receiver instead of the Worker:
 *
 *   node apps/api/scripts/metering-webhook-check.ts <public URL of port 8787>
 *     (start it first: `ol expose 8787` prints the URL; NODE_USE_ENV_PROXY=1 if a proxy adds E2B's key)
 *
 * It serves port 8787, registers a webhook to it through `E2BEvents` (what the operator route uses), runs a
 * throwaway sandbox (`devSandboxMetadata`) through a pause, a resume and a kill, rotating the webhook's secret in
 * between with a PATCH, and checks each delivery as the Worker would: the signature on the raw body (`e2bSignature`,
 * against either secret), the snake_case body (`WebhookBody`), and the `sandbox_run` it becomes. Then it reads the
 * same runs from `GET /events/sandboxes` as the backfill does and checks they become the same events, and deletes the
 * webhook. Webhooks are team-wide, so it also receives other sandboxes' events: it counts them and prints nothing of
 * them. Needs E2B_API_KEY, or an HTTPS proxy that adds it.
 */
import { createServer } from "node:http"
import { devSandboxMetadata } from "@dream/domain"
import { Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { ApiConfig } from "../src/Config.ts"
import { E2B } from "../src/e2b/E2B.ts"
import { randomBytes, toBase64Url } from "../src/lib/Bytes.ts"
import { BilledTypes, E2BEvents, fromWebhook, toMeterEvent, WebhookBody } from "../src/metering/E2BEvents.ts"
import { e2bSignature } from "../src/metering/E2BMetering.ts"

const receiver = process.argv[2]
if (receiver === undefined) throw new Error("Pass the public URL of port 8787 (`ol expose 8787`).")

interface Delivery {
  readonly headers: Record<string, string | ReadonlyArray<string> | undefined>
  readonly body: Uint8Array
}
const deliveries: Array<Delivery> = []
const server = createServer(async (request, response) => {
  const chunks: Array<Uint8Array> = []
  for await (const chunk of request) chunks.push(chunk)
  const body = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.length
  }
  deliveries.push({ headers: request.headers, body })
  response.writeHead(204, {})
  response.end()
})
await new Promise<void>((resolve) => server.listen(8787, "0.0.0.0", resolve))

const config = ApiConfig.layerTest({
  e2bApiKey: Option.some(Redacted.make(process.env.E2B_API_KEY ?? "placeholder-added-by-proxy")),
  e2bApiUrl: "https://api.e2b.app",
  e2bDomain: "e2b.app"
})
const layer = Layer.mergeAll(E2B.layer, E2BEvents.layer).pipe(
  Layer.provide(config),
  Layer.provide(FetchHttpClient.layer)
)

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${detail}`}`)
  if (!ok) process.exitCode = 1
}

const program = Effect.gen(function* () {
  const e2b = yield* E2B
  const events = yield* E2BEvents
  const first = toBase64Url(randomBytes(32))
  const second = toBase64Url(randomBytes(32))
  const settings = (secret: string) => ({
    name: "dream-metering-check",
    url: receiver,
    events: BilledTypes,
    signatureSecret: Redacted.make(secret)
  })

  const webhook = yield* events.createWebhook(settings(first))
  console.log(`registered webhook ${webhook.id} → ${webhook.url}`)
  yield* Effect.addFinalizer(() =>
    events.deleteWebhook(webhook.id).pipe(
      Effect.andThen(events.webhooks),
      Effect.tap((left) => Effect.sync(() => check("webhook deleted", !left.some((w) => w.id === webhook.id)))),
      Effect.orDie
    )
  )

  const sandbox = yield* Effect.acquireRelease(
    e2b.create({
      template: "base",
      timeoutSeconds: 120,
      autoPause: false,
      envVars: {},
      metadata: devSandboxMetadata("metering-webhook-check"),
      rules: {}
    }),
    (created) => e2b.kill(created.sandboxId).pipe(Effect.ignore)
  )
  const id = sandbox.sandboxId
  console.log(`sandbox ${id}`)
  yield* Effect.sleep("3 seconds")
  yield* e2b.pause(id)
  const ours = (type: string) =>
    deliveries.filter((d) => {
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(WebhookBody))(new TextDecoder().decode(d.body))
      return Option.isSome(decoded) && decoded.value.sandbox_id === id && decoded.value.type === type
    })
  const waitFor = (type: string) =>
    Effect.gen(function* () {
      for (let i = 0; i < 60 && ours(type).length === 0; i++) yield* Effect.sleep("500 millis")
      return ours(type)
    })
  check("paused delivered", (yield* waitFor(BilledTypes[0])).length > 0)

  // Rotate, as `register` does on a second call: the kill should arrive signed with the new secret.
  const updated = yield* events.updateWebhook(webhook.id, settings(second))
  check("PATCH found the webhook", Option.isSome(updated))
  const settle = Number(process.env.ROTATE_SETTLE_SECONDS ?? 15)
  yield* Effect.sleep(Duration.seconds(settle))
  yield* e2b.connect(id, 60)
  yield* Effect.sleep("2 seconds")
  yield* e2b.kill(id)
  check("killed delivered", (yield* waitFor(BilledTypes[1])).length > 0)

  const metered = new Map<
    string,
    NonNullable<ReturnType<typeof toMeterEvent> extends Option.Option<infer A> ? A : never>
  >()
  for (const [type, secrets] of [
    [BilledTypes[0], [first, second]],
    [BilledTypes[1], [second, first]]
  ] as const) {
    console.log(`${type}: ${ours(type).length} deliveries`)
    for (const delivery of ours(type)) {
      const signature = String(delivery.headers["e2b-signature"] ?? "")
      const matches: Array<string> = []
      for (const secret of secrets) if ((yield* e2bSignature(secret, delivery.body)) === signature) matches.push(secret)
      check(
        `${type} signature`,
        matches.length > 0,
        matches[0] === second ? "new secret" : matches[0] === first ? "first secret" : "no match"
      )
      const body = Schema.decodeUnknownSync(Schema.fromJsonString(WebhookBody))(new TextDecoder().decode(delivery.body))
      const run = toMeterEvent(fromWebhook(body))
      check(`${type} becomes a sandbox_run`, Option.isSome(run))
      if (Option.isSome(run)) {
        metered.set(run.value.id, run.value)
        console.log(`     ${run.value.id} owner=${run.value.owner} ${JSON.stringify(run.value.quantities)}`)
        console.log(`     ${JSON.stringify(run.value.dimensions)}`)
      }
    }
  }
  console.log(
    `(${deliveries.length - ours(BilledTypes[0]).length - ours(BilledTypes[1]).length} other deliveries ignored)`
  )

  // The backfill's view of the same runs: same ids, same events.
  let page = yield* events.billed(0, 100)
  for (let i = 0; i < 30 && [...metered.keys()].some((key) => !page.some((e) => `e2b:${e.id}` === key)); i++) {
    yield* Effect.sleep("2 seconds")
    page = yield* events.billed(0, 100)
  }
  for (const [eventId, fromHook] of metered) {
    const listed = page.find((event) => `e2b:${event.id}` === eventId)
    check(`${eventId} listed by /events/sandboxes`, listed !== undefined)
    if (listed === undefined) continue
    const run = toMeterEvent(listed)
    check(
      `${eventId} the same event from both`,
      Option.isSome(run) && JSON.stringify(run.value) === JSON.stringify(fromHook),
      Option.isSome(run) ? "" : "didn't decode"
    )
  }
}).pipe(Effect.scoped, Effect.provide(layer), Effect.timeout(Duration.minutes(3)))

await Effect.runPromise(
  program.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.error("check failed", cause)
        process.exitCode = 1
      })
    )
  )
)
process.exit()
