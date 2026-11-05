/**
 * Drives the deployed API from Node through the app's own data layer, for end-to-end runs
 * before the app is on a phone. Needs DREAM_SESSION (see infra/scripts/dev-login.ts).
 *
 *   node apps/mobile/scripts/e2e.ts connect chatgpt|claude     start a model sign-in, print what the person must do
 *   node apps/mobile/scripts/e2e.ts poll <connectionId>          wait for a device-code sign-in
 *   node apps/mobile/scripts/e2e.ts complete <connectionId>      finish a Claude sign-in (code on stdin)
 *   node apps/mobile/scripts/e2e.ts idea "<text>"                create a project from an idea
 *   node apps/mobile/scripts/e2e.ts watch <projectId> [seconds]  print the project's live events
 *   node apps/mobile/scripts/e2e.ts say <projectId> "<text>"     send a chat message
 *   node apps/mobile/scripts/e2e.ts answer <projectId> <messageId> "<option or text>"
 */
import { type ModelConnectionId, type MessageId, type ProjectId, type User } from "@dream/domain"
import { DateTime, Duration, Effect, Layer, Option, Redacted, Schedule, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { readFileSync } from "node:fs"
import { AppClient } from "../src/data/AppClient.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { ProjectStates } from "../src/data/ProjectStates.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"

const apiUrl = process.env.DREAM_API_URL ?? "https://dream.omer.build"
const token = process.env.DREAM_SESSION?.trim()
const [cmd, a, b, c] = process.argv.slice(2)

const layer = makeAppLayer(
  { apiUrl, backend: "live" },
  { storage: SecureStorage.layerMemory(), webSocket: Socket.layerWebSocketConstructorGlobal, fetch: globalThis.fetch }
).pipe(Layer.provideMerge(Reactivity.layer))

const show = (x: unknown) => console.log(JSON.stringify(x, (_k, v) => (Redacted.isRedacted(v) ? "<redacted>" : v), 2))

const program = Effect.gen(function* () {
  if (!token) return console.error("Set DREAM_SESSION")
  const app = yield* AppClient
  const session = yield* Session
  const placeholder: User = { id: "usr_pending" as User["id"], email: "pending", createdAt: yield* DateTime.now }
  yield* session.signIn({ token: Redacted.make(token), user: placeholder })

  switch (cmd) {
    case "connect": {
      const r = yield* app.StartModelConnection({ provider: a as never })
      return show(r)
    }
    case "poll": {
      const r = yield* app
        .GetModelConnection({ connectionId: a as ModelConnectionId })
        .pipe(
          Effect.retry(Schedule.spaced(Duration.seconds(5))),
          Effect.repeat({ schedule: Schedule.spaced(Duration.seconds(5)), until: (x) => x.status !== "pending" }),
          Effect.timeout("15 minutes")
        )
      return show(r)
    }
    case "complete": {
      const code = readFileSync(0, "utf8").trim()
      return show(
        yield* app.CompleteModelConnection({ connectionId: a as ModelConnectionId, code: Redacted.make(code) as never })
      )
    }
    case "idea":
      return show(yield* app.CreateProject({ idea: a as never }))
    case "say":
      return show(yield* app.SendMessage({ projectId: a as ProjectId, text: b } as never))
    case "answer":
      return show(
        yield* app.AnswerQuestion({ projectId: a as ProjectId, messageId: b as MessageId, answer: c } as never)
      )
    case "watch": {
      const states = yield* ProjectStates
      const seconds = Number(b ?? "120")
      yield* states.state(a as ProjectId).pipe(
        Stream.filter(Option.isSome),
        Stream.map((s) => s.value),
        Stream.runForEach((s) =>
          Effect.sync(() =>
            console.log(
              `[${new Date().toISOString().slice(11, 19)}] ${s.status.phase} working=${s.working} now=${JSON.stringify(s.status.now ?? null)} messages=${s.messages.length} last=${JSON.stringify(s.messages.at(-1) ?? null).slice(0, 400)}`
            )
          )
        ),
        Effect.timeout(Duration.seconds(seconds)),
        Effect.ignore
      )
      return
    }
    default:
      return console.error("unknown command; see the header of this file")
  }
})

program.pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise).then(
  () => process.exit(0),
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
