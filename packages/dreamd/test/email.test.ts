/**
 * `dream email` from the CLI, end to end against a stand-in API on a Unix socket: what it sends, what it prints, and
 * how it explains a refusal.
 */
import { assert, describe, it } from "@effect/vitest"
import {
  HttpRpcSerialization,
  type MessageId,
  EmailLimitReached,
  UpstreamFailure,
  Routes,
  SandboxAuth,
  SandboxRpcs,
  TextMessage
} from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { mkdtempSync, writeFileSync } from "node:fs"
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

const NewApi = RpcGroup.make(...(rpcs("SendEmail") as [any]))
/** An API from before `dream email`. */
const OldApi = RpcGroup.make(...(rpcs("SendMessage") as [any]))

const serve = (group: RpcGroup.RpcGroup<any>, handlers: Layer.Layer<any, never, any>) =>
  Effect.gen(function* () {
    const socket = join(mkdtempSync(join(tmpdir(), "dream-email-")), "dreamd.sock")
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

const copy = (payload: any) =>
  TextMessage.make({
    id: "msg_email" as MessageId,
    projectId: Fx.liftLog.id,
    createdAt: now,
    from: "agent",
    text: payload.markdown,
    media: [],
    email: { subject: payload.subject, to: "ada@example.com", sentAt: now },
    ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo })
  })

describe("dream email", () => {
  it.live("sends the file's markdown with its subject, and says where it went", () =>
    Effect.gen(function* () {
      const payloads: Array<any> = []
      const socket = yield* serve(
        NewApi,
        NewApi.toLayer({
          SendEmail: (payload: any) => Effect.sync(() => (payloads.push(payload), copy(payload)))
        } as any)
      )
      const file = join(mkdtempSync(join(tmpdir(), "dream-email-md-")), "steps.md")
      writeFileSync(file, "## Steps\n\n1. Open it\n")
      const out = yield* run(socket, [
        "email",
        "--subject",
        " Apple Developer steps ",
        "--file",
        file,
        "--reply-to",
        "msg_q"
      ])
      assert.deepStrictEqual(payloads[0], {
        subject: "Apple Developer steps",
        markdown: "## Steps\n\n1. Open it\n",
        replyTo: "msg_q"
      })
      assert.include(out, 'Emailed "Apple Developer steps" to ada@example.com')
      assert.include(out, "msg_email")
    })
  )

  it.live("refuses a subject on two lines before sending anything", () =>
    Effect.gen(function* () {
      const socket = yield* serve(NewApi, NewApi.toLayer({ SendEmail: () => Effect.die("unused") } as any))
      const out = yield* run(socket, ["email", "--subject", "one\ntwo", "Steps"])
      assert.include(out, "one line")
    })
  )

  it.live("explains the limit and a deployment that can't send", () =>
    Effect.gen(function* () {
      const limited = yield* serve(
        NewApi,
        NewApi.toLayer({
          SendEmail: () =>
            Effect.fail(
              new EmailLimitReached({ limit: 10, message: "This project has sent the 10 emails it can in a day." })
            )
        } as any)
      )
      assert.include(yield* run(limited, ["email", "--subject", "S", "x"]), "sent the 10 emails it can in a day")
      const off = yield* serve(
        NewApi,
        NewApi.toLayer({
          SendEmail: () =>
            Effect.fail(
              new UpstreamFailure({
                service: "Email",
                message: "this Dream deployment can't send email, so nothing was sent"
              })
            )
        } as any)
      )
      assert.include(
        yield* run(off, ["email", "--subject", "S", "x"]),
        "Email failed: this Dream deployment can't send email"
      )
    })
  )

  it.live("against an API from before it, says to use Chat", () =>
    Effect.gen(function* () {
      const socket = yield* serve(OldApi, OldApi.toLayer({ SendMessage: () => Effect.die("unused") } as any))
      assert.include(yield* run(socket, ["email", "--subject", "S", "x"]), "can't send email yet")
    })
  )
})
