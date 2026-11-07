/**
 * Threads from the CLI: `--reply-to` on what the agent sends, and `dream ask revise`, end to end against a
 * stand-in API on a Unix socket, including one from before threads.
 */
import { assert, describe, it } from "@effect/vitest"
import {
  HttpRpcSerialization,
  type MessageId,
  QuestionMessage,
  Routes,
  SandboxAuth,
  SandboxRpcs,
  TextMessage
} from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, DateTime, Effect, Layer } from "effect"
import { CliOutput, Command } from "effect/cli"
import { TestConsole } from "effect/testing"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { RpcGroup, RpcServer } from "effect/rpc"
import { dream } from "../src/Cli.ts"
import { Dream } from "../src/cli/Client.ts"
import { PageCheck } from "../src/cli/PageCheck.ts"
import { invalidInvocation } from "../src/cli/Usage.ts"

const now = DateTime.makeUnsafe("2026-11-04T22:10:00Z")
const rpcs = (...tags: Array<string>) => tags.map((tag) => SandboxRpcs.requests.get(tag as never)!)

const NewApi = RpcGroup.make(...(rpcs("SendMessage", "ReviseQuestion") as [any]))
/** An API from before threads: `SendMessage` drops `replyTo`, and there's no `ReviseQuestion`. */
const OldApi = RpcGroup.make(...(rpcs("SendMessage") as [any]))

const serve = (group: RpcGroup.RpcGroup<any>, handlers: Layer.Layer<any, never, any>) =>
  Effect.gen(function* () {
    const socket = join(mkdtempSync(join(tmpdir(), "dream-threads-")), "dreamd.sock")
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

const sent = (payload: any, replyTo?: MessageId) =>
  TextMessage.make({
    id: "msg_sent" as MessageId,
    projectId: Fx.liftLog.id,
    createdAt: now,
    from: "agent",
    text: payload.text,
    media: [],
    ...(replyTo === undefined ? {} : { replyTo })
  })

describe("threads from the CLI", () => {
  it.live("--reply-to puts a message in the thread, and says so", () =>
    Effect.gen(function* () {
      const payloads: Array<any> = []
      const socket = yield* serve(
        NewApi,
        NewApi.toLayer({
          SendMessage: (payload: any) =>
            Effect.sync(() => {
              payloads.push(payload)
              return sent(payload, payload.replyTo === "msg_reply" ? ("msg_root" as MessageId) : payload.replyTo)
            }),
          ReviseQuestion: () => Effect.die("unused")
        } as any)
      )
      const out = yield* run(socket, ["message", "--reply-to", "msg_reply", "It does now."])
      assert.strictEqual(payloads[0].replyTo, "msg_reply")
      assert.include(out, "Sent msg_sent")
      // A reply to a reply lands in the thread on the first message, which is what it names.
      assert.include(out, "in the thread on msg_root")
    })
  )

  it.live("against an API from before threads, says the message went to Chat on its own", () =>
    Effect.gen(function* () {
      const socket = yield* serve(
        OldApi,
        OldApi.toLayer({ SendMessage: (payload: any) => Effect.succeed(sent(payload)) } as any)
      )
      const out = yield* run(socket, ["message", "--reply-to", "msg_root", "It does now."])
      assert.include(out, "went to Chat on its own")
      const revise = yield* run(socket, ["ask", "revise", "msg_q", "--question", "Which sound?"])
      assert.include(revise, "predates `dream ask revise`")
    })
  )

  it.live("dream ask revise sends only what changes, and clears with an empty flag", () =>
    Effect.gen(function* () {
      const payloads: Array<any> = []
      const socket = yield* serve(
        NewApi,
        NewApi.toLayer({
          SendMessage: () => Effect.die("unused"),
          ReviseQuestion: (payload: any) =>
            Effect.sync(() => {
              payloads.push(payload)
              const { why: _, ...question } = Fx.timerSounds
              return QuestionMessage.make({ ...question, options: payload.options, revisedAt: now })
            })
        } as any)
      )
      const out = yield* run(socket, [
        "ask",
        "revise",
        Fx.timerSounds.id,
        "--option",
        "A chime that gets louder",
        "--option",
        "Soft chime",
        "--why",
        ""
      ])
      assert.deepStrictEqual(payloads[0], {
        messageId: Fx.timerSounds.id,
        options: ["A chime that gets louder", "Soft chime"],
        why: null
      })
      assert.include(out, `Changed ${Fx.timerSounds.id} in place`)
      const lonely = yield* run(socket, ["ask", "revise", Fx.timerSounds.id, "--show", "Soft chime=a.m4a"])
      assert.include(lonely, "list the options too")
    })
  )
})
