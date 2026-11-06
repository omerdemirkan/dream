/**
 * `dream notify` end to end through the CLI against a stand-in API on a Unix socket: setting an app up, sending as
 * it, what the agent reads back, the exit status a job sees, and an API from before app notifications.
 */
import { assert, describe, it } from "@effect/vitest"
import {
  type AccessMessage,
  type AppNotification,
  type AppNotificationOutcome,
  type AppSender,
  HttpRpcSerialization,
  InvalidRequest,
  type MessageId,
  Routes,
  SandboxAuth,
  SandboxRpcs
} from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, DateTime, Effect, Layer, Ref } from "effect"
import { CliOutput, Command } from "effect/cli"
import { TestConsole } from "effect/testing"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { RpcGroup, RpcServer } from "effect/rpc"
import { dream } from "../src/Cli.ts"
import { Dream } from "../src/cli/Client.ts"
import { appNotifications as formatList } from "../src/cli/Format.ts"
import { PageCheck } from "../src/cli/PageCheck.ts"
import { invalidInvocation } from "../src/cli/Usage.ts"

const now = DateTime.makeUnsafe("2026-11-04T22:10:00Z")
const rpcs = (...tags: Array<string>) => tags.map((tag) => SandboxRpcs.requests.get(tag as never)!)

const NewApi = RpcGroup.make(
  ...(rpcs("SetUpAppNotifications", "SendAppNotification", "ListAppNotifications", "WithdrawNotification") as [any])
)
/** An API from before app notifications: only withdrawing the agent's own. */
const OldApi = RpcGroup.make(...(rpcs("WithdrawNotification") as [any]))

const serve = (group: RpcGroup.RpcGroup<any>, handlers: Layer.Layer<any, never, any>) =>
  Effect.gen(function* () {
    const socket = join(mkdtempSync(join(tmpdir(), "dream-notify-")), "dreamd.sock")
    yield* Layer.launch(
      HttpRouter.serve(RpcServer.layerHttp({ group, path: Routes.sandbox, protocol: "http" }), {
        disableListenLog: true,
        disableLogger: true
      }).pipe(
        Layer.provide([handlers, HttpRpcSerialization, Layer.succeed(SandboxAuth, (effect) => effect as any)]),
        Layer.provide(NodeHttpServer.layer(() => createServer(), { path: socket }))
      )
    ).pipe(Effect.forkScoped)
    yield* Effect.sleep("100 millis")
    return socket
  })

/** Runs `dream` against the socket: whether it exited 0, and what it printed or failed with. */
const run = (socket: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const printed: Array<string> = []
    const presenter = CliOutput.layerPresenter({
      present: (event) =>
        Effect.sync(() => {
          if (event._tag === "InvalidInvocation") printed.push(invalidInvocation(event))
        })
    })
    const exit = yield* Command.runWith(dream, { version: "test" })(args).pipe(Effect.provide(presenter), Effect.exit)
    if (exit._tag === "Success") return { ok: true, text: (yield* TestConsole.logLines).join("\n") }
    const failure = exit.cause.reasons[0]
    return {
      ok: false,
      text: printed[0] ?? (failure?._tag === "Fail" ? (failure.error as Error).message : `DEFECT ${String(failure)}`)
    }
  }).pipe(
    Effect.provide(TestConsole.layer),
    Effect.provide(
      Layer.mergeAll(
        Dream.layer,
        FetchHttpClient.layer,
        NodeServices.layer,
        PageCheck.layerTest(Effect.die("no page checks here"))
      ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { DREAM_SOCKET: socket } }))))
    )
  )

const card = (payload: any, state: AccessMessage["state"]): AccessMessage => ({
  _tag: "Access",
  id: "msg_card" as MessageId,
  projectId: Fx.morningBrief.id,
  createdAt: now,
  notificationId: "2f0b8a52-3f7e-4d0c-9a51-6c1f4b9e7d21" as AccessMessage["notificationId"] & string,
  request: { _tag: "Notifications", app: payload.app, name: payload.name, often: payload.often },
  why: payload.why,
  state
})

describe("dream notify", () => {
  it.live("sets an app up, sends as it, and lists what it sent", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<unknown>>([])
      const outcome = yield* Ref.make<AppNotificationOutcome>("sent")
      const handlers = NewApi.toLayer({
        SetUpAppNotifications: (payload: any) =>
          Ref.update(calls, (all) => [...all, payload]).pipe(
            Effect.as({
              app: {
                ...Fx.morningBriefApp,
                id: payload.app,
                name: payload.name,
                why: payload.why,
                often: payload.often,
                state: { _tag: "Waiting" }
              } as AppSender,
              card: card(payload, { _tag: "Open" })
            })
          ),
        SendAppNotification: (payload: any) =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (all) => [...all, payload])
            return {
              id: "7c1e2d9a-41b6-4f3e-8a0d-2b5c9e6f1a09",
              app: payload.app,
              ...(payload.title === undefined ? {} : { title: payload.title }),
              text: payload.text,
              url: "https://fares.example/routes/lis",
              outcome: yield* Ref.get(outcome),
              ...((yield* Ref.get(outcome)) === "held" ? { held: "hour" } : {}),
              sentAt: now
            } as AppNotification
          }),
        ListAppNotifications: () =>
          Effect.succeed({ apps: [Fx.morningBriefApp], notifications: Fx.morningBriefAppNotifications }),
        WithdrawNotification: () => Effect.void
      } as any)
      const socket = yield* serve(NewApi, handlers)

      const setUp = yield* run(socket, [
        "notify",
        "setup",
        "fare-watch",
        "--name",
        "Fare watch",
        "--icon",
        "airplane",
        "--color",
        "blue",
        "--why",
        "When a fare you're watching drops below your target",
        "--often",
        "A few times a week at most",
        "--url",
        "/"
      ])
      assert.isTrue(setUp.ok, setUp.text)
      assert.include(setUp.text, "Fare watch (fare-watch) is waiting for them to allow it: card msg_card")
      assert.include(setUp.text, `Its card reads "Let Fare watch notify you"`)
      assert.deepStrictEqual((yield* Ref.get(calls))[0], {
        app: "fare-watch",
        name: "Fare watch",
        why: "When a fare you're watching drops below your target",
        often: "A few times a week at most",
        icon: { _tag: "Symbol", name: "airplane" },
        color: "blue",
        url: "/"
      })

      const sent = yield* run(socket, [
        "notify",
        "--app",
        "fare-watch",
        "--title",
        "Lisbon dropped to $412",
        "--key",
        "lis",
        "--url",
        "/routes/lis",
        "Round trip May 14–21."
      ])
      assert.isTrue(sent.ok)
      assert.strictEqual(
        sent.text,
        'Sent to their phone as fare-watch; a tap opens https://fares.example/routes/lis. "Lisbon dropped to $412" (7c1e2d9a-41b6-4f3e-8a0d-2b5c9e6f1a09).'
      )
      assert.deepStrictEqual((yield* Ref.get(calls))[1], {
        app: "fare-watch",
        text: "Round trip May 14–21.",
        title: "Lisbon dropped to $412",
        url: "/routes/lis",
        key: "lis",
        quiet: false,
        dryRun: false
      })

      // Held back by a limit or their settings is the app doing its part: exit 0, with what happened.
      yield* Ref.set(outcome, "held")
      const held = yield* run(socket, ["notify", "--app", "fare-watch", "Again"])
      assert.isTrue(held.ok)
      assert.include(held.text, "Held: fare-watch is over its limit of 6 an hour")
      yield* Ref.set(outcome, "waiting")
      const waiting = yield* run(socket, ["notify", "--app", "fare-watch", "--dry-run", "Early"])
      assert.isTrue(waiting.ok)
      assert.strictEqual(
        waiting.text,
        "Dry run, nothing sent or kept. It would be not sent: they haven't allowed fare-watch yet; its card is waiting in Chat."
      )
      assert.include(JSON.stringify((yield* Ref.get(calls)).at(-1)), '"dryRun":true')

      const listed = yield* run(socket, ["notify", "list"])
      assert.isTrue(listed.ok)
      assert.include(listed.text, 'morning-brief "Morning Brief": allowed.')
      assert.include(listed.text, "3 reached their phone in the last 30 days; they opened 1.")
      assert.include(listed.text, "[sent, replaced]")

      const withdrawn = yield* run(socket, ["notify", "withdraw", "7c1e2d9a-41b6-4f3e-8a0d-2b5c9e6f1a09"])
      assert.strictEqual(withdrawn.text, "Withdrew notification 7c1e2d9a-41b6-4f3e-8a0d-2b5c9e6f1a09.")
    }).pipe(Effect.scoped)
  )

  it.live("fails, so a job wakes the agent, only when the call is wrong", () =>
    Effect.gen(function* () {
      const handlers = NewApi.toLayer({
        SetUpAppNotifications: () => Effect.die("unused"),
        SendAppNotification: () =>
          Effect.fail(new InvalidRequest({ message: 'No app "fare-watch" is set up to notify them.' })),
        ListAppNotifications: () => Effect.succeed({ apps: [], notifications: [] }),
        WithdrawNotification: () => Effect.void
      } as any)
      const socket = yield* serve(NewApi, handlers)
      const unknown = yield* run(socket, ["notify", "--app", "fare-watch", "Hi"])
      assert.isFalse(unknown.ok)
      assert.include(unknown.text, 'No app "fare-watch" is set up')
      const noApp = yield* run(socket, ["notify", "Hi"])
      assert.isFalse(noApp.ok)
      assert.include(noApp.text, "dream message --notify")
      const badId = yield* run(socket, ["notify", "--app", "Fare Watch", "Hi"])
      assert.include(badId.text, "isn't an app id")
      const long = yield* run(socket, ["notify", "--app", "fare-watch", "x".repeat(501)])
      assert.include(long.text, "501 characters; 500 at most")
      const twoLines = yield* run(socket, ["notify", "--app", "fare-watch", "--title", "a\nb", "Hi"])
      assert.include(twoLines.text, "--title has to be one line")
      const image = yield* run(socket, [
        "notify",
        "setup",
        "fare-watch",
        "--name",
        "Fare watch",
        "--why",
        "w",
        "--often",
        "o",
        "--icon",
        "Not An Icon"
      ])
      assert.include(image.text, "isn't an SF Symbol name")
      const none = yield* run(socket, ["notify", "list"])
      assert.include(none.text, "No app is set up to notify them.")
    }).pipe(Effect.scoped)
  )

  it.live("against an API from before app notifications: a clear line, and withdraw still works", () =>
    Effect.gen(function* () {
      const socket = yield* serve(OldApi, OldApi.toLayer({ WithdrawNotification: () => Effect.void } as any))
      for (const args of [
        ["notify", "--app", "fare-watch", "Hi"],
        ["notify", "list"],
        ["notify", "setup", "fare-watch", "--name", "Fare watch", "--why", "w", "--often", "o"]
      ]) {
        const result = yield* run(socket, args)
        assert.isFalse(result.ok)
        assert.isTrue(result.text.startsWith("Nothing was sent: this Dream's API predates notifications from apps"))
      }
      const withdrawn = yield* run(socket, ["notify", "withdraw", "7c1e2d9a-41b6-4f3e-8a0d-2b5c9e6f1a09"])
      assert.isTrue(withdrawn.ok)
    }).pipe(Effect.scoped)
  )
})

describe("what dream notify list prints", () => {
  it("each app's state, and each notification's outcome", () => {
    const text = formatList(
      {
        apps: [
          { ...Fx.morningBriefApp, delivery: "quiet" },
          { ...Fx.morningBriefApp, id: "fare-watch" as AppSender["id"], name: "Fare watch", state: { _tag: "Waiting" } }
        ],
        notifications: Fx.morningBriefAppNotifications
      },
      now
    )
    assert.include(text, 'morning-brief "Morning Brief": allowed, quietly (no sound).')
    assert.include(text, 'fare-watch "Fare watch": waiting for them to allow it.')
    assert.include(text, "Nothing sent in the last 30 days.")
  })
})
