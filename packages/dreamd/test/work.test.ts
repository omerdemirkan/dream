/**
 * `dream work` and `--work`, end to end through the CLI against a stand-in API on a Unix socket: what the agent
 * reads back, and what happens against an API from before workstreams.
 */
import { assert, describe, it } from "@effect/vitest"
import {
  HttpRpcSerialization,
  type MessageId,
  Routes,
  SandboxAuth,
  SandboxRpcs,
  TextMessage,
  type Workstream,
  type WorkstreamId,
  type Workstreams
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
import { PageCheck } from "../src/cli/PageCheck.ts"
import { workstreams as formatWorkstreams } from "../src/cli/Format.ts"
import { invalidInvocation } from "../src/cli/Usage.ts"

const now = DateTime.makeUnsafe("2026-11-04T22:10:00Z")
const rpcs = (...tags: Array<string>) => tags.map((tag) => SandboxRpcs.requests.get(tag as never)!)

/** An API that knows workstreams: records what it was sent, and keeps a list. */
const NewApi = RpcGroup.make(
  ...(rpcs("SendMessage", "ListWorkstreams", "StartWorkstream", "UpdateWorkstream", "EndWorkstream") as [any])
)
/** An API from before workstreams: `SendMessage` drops the label, and nothing else exists. */
const OldApi = RpcGroup.make(...(rpcs("SendMessage") as [any]))

const serve = (group: RpcGroup.RpcGroup<any>, handlers: Layer.Layer<any, never, any>) =>
  Effect.gen(function* () {
    const socket = join(mkdtempSync(join(tmpdir(), "dream-work-")), "dreamd.sock")
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

/** Runs `dream` against the socket: what it printed, or the line it failed with. */
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
    if (exit._tag === "Success") return (yield* TestConsole.logLines).join("\n")
    const failure = exit.cause.reasons[0]
    return printed[0] ?? (failure?._tag === "Fail" ? (failure.error as Error).message : `DEFECT ${String(failure)}`)
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

const sentMessage = (text: string, workstream?: WorkstreamId) =>
  TextMessage.make({
    id: "msg_sent" as MessageId,
    projectId: Fx.liftLog.id,
    createdAt: now,
    from: "agent",
    text,
    media: [],
    ...(workstream === undefined ? {} : { workstream })
  })

describe("dream work", () => {
  it.live("starts, updates and ends workstreams, and prints the card as they'll see it", () =>
    Effect.gen(function* () {
      const list = yield* Ref.make<ReadonlyArray<Workstream>>([])
      const report = Effect.map(Ref.get(list), (workstreams): Workstreams => ({ workstreams, waiting: [] }))
      const handlers = NewApi.toLayer({
        SendMessage: (payload: any) => Effect.succeed(sentMessage(payload.text, payload.workstream)),
        ListWorkstreams: () => report,
        StartWorkstream: (payload: any) =>
          Ref.update(list, (all) => [
            ...all,
            {
              id: `ws_${all.length + 1}` as WorkstreamId,
              title: payload.title,
              ...(payload.now === undefined ? {} : { now: payload.now }),
              state: "active" as const,
              startedAt: DateTime.add(now, { minutes: all.length }),
              updatedAt: now
            }
          ]).pipe(Effect.andThen(report)),
        UpdateWorkstream: (payload: any) =>
          Ref.update(list, (all) =>
            all.map((w) => (w.id === payload.workstreamId ? { ...w, now: payload.now } : w))
          ).pipe(Effect.andThen(report)),
        EndWorkstream: (payload: any) =>
          Ref.update(list, (all) =>
            all.map((w) =>
              w.id === payload.workstreamId ? { ...w, state: payload.state, result: payload.result, endedAt: now } : w
            )
          ).pipe(Effect.andThen(report))
      } as any)
      const socket = yield* serve(NewApi, handlers)

      const first = yield* run(socket, ["work", "start", "Double charges", "--now", "Reproducing it"])
      assert.include(first, "Started ws_1. Nothing was sent to them.")
      assert.include(first, "One active workstream (ws_1). The card still shows your --now sentence")

      const second = yield* run(socket, ["work", "start", "Trip screen redesign"])
      assert.include(second, "On the card, in place of your --now sentence")
      assert.include(second, "● Double charges / Reproducing it  [ws_1]")
      assert.include(second, "● Trip screen redesign (no now-line)  [ws_2]")

      const updated = yield* run(socket, ["work", "update", "ws_2", "--now", "Mocking two directions"])
      assert.include(updated, "only its row changed, with no message")
      assert.include(updated, "● Trip screen redesign / Mocking two directions  [ws_2]")

      const done = yield* run(socket, ["work", "done", "ws_1", "--result", "Fixed, refunds sent"])
      assert.include(done, "ws_1 is done: it folds into the card's last line. Nothing was sent to them")
      assert.include(done, "One active workstream (ws_2)")
      assert.include(done, "Ended: Double charges (done")

      const sent = yield* run(socket, ["message", "Two mocks tonight.", "--work", "ws_2"])
      assert.strictEqual(sent, "Sent msg_sent.")

      const tooLong = yield* run(socket, ["work", "start", "x".repeat(41)])
      assert.include(tooLong, "a workstream's title is 40 at most")
      const nothing = yield* run(socket, ["work", "update", "ws_2"])
      assert.strictEqual(nothing, "Say what changes: --now and/or --title.")
    }).pipe(Effect.scoped)
  )

  it.live("against an API from before workstreams: a clear line instead of a crash, and a note on --work", () =>
    Effect.gen(function* () {
      const handlers = OldApi.toLayer({
        SendMessage: (payload: any) => Effect.succeed(sentMessage(payload.text))
      } as any)
      const socket = yield* serve(OldApi, handlers)
      for (const args of [["work"], ["work", "list"], ["work", "start", "Double charges"], ["work", "done", "ws_1"]]) {
        const printed = yield* run(socket, args)
        assert.isTrue(printed.startsWith("Nothing changed: this Dream's API predates workstreams"), printed)
      }
      const sent = yield* run(socket, ["message", "Two mocks tonight.", "--work", "ws_2"])
      assert.strictEqual(
        sent,
        "Sent msg_sent. It went without a workstream label: this Dream's API predates workstreams."
      )
      assert.strictEqual(yield* run(socket, ["message", "Two mocks tonight."]), "Sent msg_sent.")
    }).pipe(Effect.scoped)
  )
})

describe("what the card shows", () => {
  it("rows, a waiting one first, the summary past three, and the folded line", () => {
    const more = ["Onboarding", "Search"].map(
      (title, i): Workstream => ({
        ...Fx.liftLogWorkstreams[0]!,
        id: `ws_more${i}` as WorkstreamId,
        title,
        startedAt: DateTime.makeUnsafe(`2026-11-04T22:0${7 + i}:00Z`)
      })
    )
    const printed = formatWorkstreams(
      {
        workstreams: [...Fx.liftLogWorkstreams, ...more],
        waiting: [{ workstream: "ws_timer" as WorkstreamId, messageId: "msg_sound" as MessageId }]
      },
      now
    ).split("\n")
    assert.deepStrictEqual(printed, [
      "On the card, in place of your --now sentence (which Home and older apps still show):",
      "  ● Rest timer / amber, at the top: waiting on them while msg_sound is open  [ws_timer]",
      "  ● Progress charts / Charting estimated 1RM for each lift  [ws_charts]",
      "  3 more: Android?, Onboarding, Search  (past 3 active, the last row sums up the rest; all of them show when they open the card)",
      "  ✓ Health import · 214 workouts from a sample export  (finished in the last few days, folded)",
      "Ended: Health import (done 2026-11-04T21:40Z (30m ago)) [ws_health]"
    ])
  })

  it("says when a row's words are cut", () => {
    const long: Workstream = {
      ...Fx.liftLogWorkstreams[0]!,
      now: "Charting estimated one-rep max for squat, bench, deadlift and overhead press"
    }
    const printed = formatWorkstreams({ workstreams: [long, Fx.liftLogWorkstreams[1]!], waiting: [] }, now)
    assert.include(printed, "Charting estimated one-rep max for squat,…")
    assert.include(printed, "Cut: a row is one line of title and one line of now")
  })
})
