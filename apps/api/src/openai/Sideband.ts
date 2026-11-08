/**
 * The sideband that meters a WebRTC call or GPT-Live session the gateway started but can't see (its media goes
 * between the browser and OpenAI): it attaches to the call (`wss://…/v1/realtime?call_id=rtc_…`, or a Live
 * session's `…/attach`) with Dream's key and meters what OpenAI reports there until the call ends
 * (`Realtime.ts`). `OpenAICallDO` holds one per call.
 */
import { UpstreamFailure } from "@dream/domain"
import { Clock, DateTime, Duration, Effect, Option, Redacted } from "effect"
import { ApiConfig } from "../Config.ts"
import { Meter } from "../metering/Meter.ts"
import { sessionMeter, type Socket } from "./Realtime.ts"
import { OpenAIUpstream, type SidebandRequest } from "./Runtime.ts"
import { toEvent } from "./Usage.ts"

export const SidebandPath = "/attach"

/** The longest a sideband stays on: realtime sessions end at 60 minutes, Live ones well before two hours. */
const MaxCall = Duration.hours(2)

/** Attaches to `request`'s call and meters it until it ends; returns once attached. */
export const attachSideband = (request: SidebandRequest) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const upstream = yield* OpenAIUpstream
    const meter = yield* Meter
    const context = yield* Effect.context<never>()
    const base = config.openaiApiUrl.replace(/\/+$/, "")
    const url =
      request.kind === "realtime"
        ? `${base}/v1/realtime?call_id=${encodeURIComponent(request.id)}`
        : `${base}/v1/live/sessions/${encodeURIComponent(request.id)}/attach`
    if (Option.isNone(config.openaiApiKey))
      return yield* new UpstreamFailure({ service: "OpenAI", message: "no OpenAI key on this deployment" })
    const { socket } = yield* upstream.connect(url, {
      authorization: `Bearer ${Redacted.value(config.openaiApiKey.value)}`
    })
    const startedMs = yield* Clock.currentTimeMillis
    const session = sessionMeter(request.kind, { model: request.model, id: request.id, estimateDuration: true })
    const caller = { projectId: request.projectId, userId: request.userId }
    const record = (found: ReturnType<typeof session.onMessage>) => {
      if (found.length === 0) return
      Effect.runFork(
        Effect.gen(function* () {
          const at = yield* DateTime.now
          yield* meter.record(
            found.map(({ endpoint, usage }) =>
              toEvent(caller, endpoint, usage, { requestId: request.id, model: request.model, at })
            )
          )
        }).pipe(Effect.provideContext(context))
      )
    }
    let open = true
    const end = () => {
      if (!open) return
      open = false
      clearTimeout(timer)
      record(session.onEnd(Date.now() - startedMs))
    }
    const timer = setTimeout(() => {
      try {
        socket.close(1000, "Dream's sideband stops here")
      } catch {
        // Already closed.
      }
      end()
    }, Duration.toMillis(MaxCall))
    socket.addEventListener("message", (event: { readonly data: unknown }) => {
      if (typeof event.data === "string") record(session.onMessage(event.data))
    })
    socket.addEventListener("close", end)
    socket.addEventListener("error", end)
    return socket satisfies Socket
  })
