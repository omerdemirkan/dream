/**
 * Runs the app's data layer (the same services the screens use) against a
 * deployed API, from Node:
 *
 *   DREAM_SESSION=$(node infra/scripts/dev-login.ts session you@example.com) \
 *     node apps/mobile/scripts/check-live.ts
 *
 * It reads what Home reads, registers a test device, asks which notifications
 * are stale, and if there is a project, subscribes to it over the live socket
 * and prints the first snapshot. Nothing secret is printed.
 */
import { DeviceId, NotificationId, type User } from "@dream/domain"
import { DateTime, Effect, Layer, Option, Redacted, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { AppClient } from "../src/data/AppClient.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { ProjectStates } from "../src/data/ProjectStates.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"

const apiUrl = process.env.DREAM_API_URL ?? "https://dream.omer.build"
const token = process.env.DREAM_SESSION?.trim()

const layer = makeAppLayer(
  { apiUrl, backend: "live" },
  { storage: SecureStorage.layerMemory(), webSocket: Socket.layerWebSocketConstructorGlobal, fetch: globalThis.fetch }
).pipe(Layer.provideMerge(Reactivity.layer))

const program = Effect.gen(function* () {
  const app = yield* AppClient
  const session = yield* Session

  const refused = yield* Effect.flip(app.DevSignIn({ email: "nobody@example.com", secret: Redacted.make("wrong") }))
  console.log(`DevSignIn with a wrong secret: ${refused._tag}`)

  if (!token) return console.log("Set DREAM_SESSION to check signed-in calls.")
  const placeholder: User = { id: "usr_pending" as User["id"], email: "pending", createdAt: yield* DateTime.now }
  yield* session.signIn({ token: Redacted.make(token), user: placeholder })

  const me = yield* app.GetMe()
  console.log(`GetMe: a user at …@${me.email.split("@")[1] ?? "?"}`)
  const projects = yield* app.ListProjects()
  const asks = yield* app.ListOpenAsks()
  const connections = yield* app.ListModelConnections()
  const integrations = yield* app.ListIntegrations()
  console.log(
    `Home: ${projects.length} projects, ${asks.length} open asks, ${connections.length} model connections (${connections.map((c) => `${c.provider}:${c.status}`).join(", ") || "none"}), ${integrations.length} integrations`
  )

  const device = yield* app.RegisterDevice({
    deviceId: DeviceId.make("00000000-0000-4000-8000-00000000c0de"),
    timeZone: "America/Los_Angeles",
    appVersion: "check-live"
  })
  console.log(`RegisterDevice: ${device.platform} device, time zone ${device.timeZone}`)
  const filtered = yield* app.FilterStaleNotifications({
    notificationIds: [NotificationId.make("6f1c7a52-8f0e-4c4b-9a53-2a0f5f8d9b11")]
  })
  console.log(`FilterStaleNotifications: ${filtered.stale.length} of 1 stale`)

  const first = projects[0]
  if (!first) return console.log("No projects yet, so the live socket wasn't exercised.")
  const states = yield* ProjectStates
  const state = yield* states.state(first.project.id).pipe(
    Stream.filter(Option.isSome),
    Stream.map((s) => s.value),
    Stream.runHead,
    Effect.timeout("20 seconds")
  )
  if (Option.isNone(state)) return console.log("Live socket: no snapshot")
  const s = state.value
  console.log(
    `Live socket: snapshot of "${s.project.title}" (${s.status.phase}), ${s.messages.length} messages, working=${s.working}`
  )
})

program.pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise).then(
  () => process.exit(0),
  (error) => {
    console.error("Failed:", error)
    process.exit(1)
  }
)
