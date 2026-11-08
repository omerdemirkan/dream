/**
 * Drives the gateway running in workerd (`worker.ts`, `config.capnp`) against fake-openai, through the paths only
 * workerd has: a JSON call, a stream, a realtime WebSocket exchange (outbound upgrade, WebSocketPair, 101, waitUntil
 * while the socket is open) and a WebRTC call whose sideband a Durable Object attaches. Prints what was metered.
 *
 *   node packages/dreamd/scripts/fake-openai.ts 18790 &
 *   bun build apps/api/scripts/workerd-check/worker.ts --target=browser --format=esm \
 *     --outdir apps/api/scripts/workerd-check/dist --define 'FAKE_URL="http://127.0.0.1:18790"'
 *   workerd serve apps/api/scripts/workerd-check/config.capnp --experimental &
 *   node apps/api/scripts/workerd-check/run.ts
 */
import { Effect, Redacted } from "effect"
import { Tokens } from "../../src/auth/Tokens.ts"
import { ApiConfig } from "../../src/Config.ts"

const gateway = "http://127.0.0.1:18795"
const token = await Effect.runPromise(
  Effect.gen(function* () {
    const tokens = yield* Tokens
    return Redacted.value(yield* tokens.openaiGateway("prj_check" as never, "usr_check" as never))
  }).pipe(Effect.provide(Tokens.layer), Effect.provide(ApiConfig.layerTest()))
)
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" }
const problems: Array<string> = []

const one = await fetch(`${gateway}/v1/responses`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ model: "gpt-6-luna", input: "hi" })
})
console.log(`responses: ${one.status} ${(await one.text()).slice(0, 80)}`)
const stream = await fetch(`${gateway}/v1/responses`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ model: "gpt-6-luna", input: "hi", stream: true })
})
const streamed = await stream.text()
console.log(`stream: ${stream.status}, ${streamed.split("\n\n").length - 1} events`)

const socket = await new Promise<string>((resolve) => {
  const ws = new (WebSocket as unknown as new (url: string, init: object) => WebSocket)(
    `ws://127.0.0.1:18795/v1/realtime?model=gpt-realtime-2.1`,
    { headers: { authorization: `Bearer ${token}` } }
  )
  const timer = setTimeout(() => resolve("timeout"), 8000)
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "response.create" })))
  ws.addEventListener("message", (event) => {
    if (String(event.data).includes("response.done")) {
      clearTimeout(timer)
      ws.close()
      resolve("response.done")
    }
  })
  ws.addEventListener("error", () => resolve("error"))
})
console.log(`realtime socket: ${socket}`)
if (socket !== "response.done") problems.push(`the realtime socket said ${socket}`)

const call = await fetch(`${gateway}/v1/realtime/calls?model=gpt-realtime-2.1`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/sdp" },
  body: "v=0 offer"
})
console.log(`realtime call: ${call.status} ${call.headers.get("location")}`)
// The fake's sideband sends a response.done after 300 ms and closes after 900.
await new Promise((resolve) => setTimeout(resolve, 2500))

const events = (await (await fetch(`${gateway}/_events`)).json()) as ReadonlyArray<{
  id: string
  dimensions: Record<string, string>
}>
for (const event of events) console.log(`metered ${event.dimensions.endpoint} ${event.id}`)
const endpoints = events.map((e) => e.dimensions.endpoint)
if (endpoints.filter((e) => e === "responses").length < 2) problems.push("the JSON call or the stream wasn't metered")
if (endpoints.filter((e) => e === "realtime").length < 2) problems.push("the socket or the sideband wasn't metered")
console.log(problems.length === 0 ? "workerd check: ok" : `workerd check FAILED:\n${problems.join("\n")}`)
process.exit(problems.length === 0 ? 0 : 1)
