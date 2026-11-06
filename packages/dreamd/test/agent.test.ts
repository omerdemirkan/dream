import { existsSync, readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import {
  AgentEvent,
  type Attachment,
  DaemonEnv,
  type EventId,
  type MediaId,
  type TurnUsage,
  type WakeId
} from "@dream/domain"
import { Clock, Context, DateTime, Deferred, Duration, Effect, Layer, Option, Queue, Ref } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { Agent, backoff } from "../src/Agent.ts"
import { Api, type Report } from "../src/Api.ts"
import { Attachments } from "../src/Attachments.ts"
import { Harness, type HarnessError, type TurnResult, TurnOutcome } from "../src/harness/Harness.ts"
import type { TurnHandlers } from "../src/harness/Turn.ts"
import { Inbox } from "../src/Inbox.ts"
import { Outreach } from "../src/Outreach.ts"
import { Published } from "../src/Published.ts"
import { baseLayer, tempDir, usageReset, userMessage } from "./support.ts"

type Script = (prompt: string, handlers: TurnHandlers) => Effect.Effect<TurnResult, HarnessError>

const completed = (progressed = true): TurnResult => ({ outcome: TurnOutcome.Completed(), usage: {}, progressed })
const saying = (finalText: string): TurnResult => ({ ...completed(), finalText })

const setup = (
  options: {
    readonly steerable?: boolean
    readonly published?: Layer.Layer<Published>
    /** The real attachment copier against this API, rooted at `dir`; none by default. */
    readonly attachments?: { readonly apiUrl: string; readonly dir: string }
  } = {}
) =>
  Effect.gen(function* () {
    const turns = yield* Queue.unbounded<Script>()
    const log = yield* Ref.make<ReadonlyArray<string>>([])
    const reports = yield* Ref.make<ReadonlyArray<Report>>([])
    const layer = Agent.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Harness.layerTest({
            turns,
            log,
            ...(options.steerable === undefined ? {} : { steerable: options.steerable })
          }),
          Api.layerTest(reports),
          Outreach.layer,
          options.published ?? Published.layerNone,
          options.attachments === undefined
            ? Attachments.layerNone
            : Attachments.layer.pipe(Layer.provide(FetchHttpClient.layer))
        )
      ),
      Layer.provideMerge(Inbox.layer),
      Layer.provideMerge(
        options.attachments === undefined
          ? baseLayer(tempDir())
          : baseLayer(options.attachments.dir, { [DaemonEnv.apiUrl]: options.attachments.apiUrl })
      )
    )
    const context = yield* Layer.build(layer)
    const inbox = Context.get(context, Inbox)
    const agent = Context.get(context, Agent)
    const outreach = Context.get(context, Outreach)
    yield* Effect.forkScoped(agent.run)
    /** Wait until the scripted harness has recorded `n` entries. */
    const logged = (n: number) =>
      Effect.gen(function* () {
        while ((yield* Ref.get(log)).length < n) yield* Effect.yieldNow
        return yield* Ref.get(log)
      })
    const idle = Effect.gen(function* () {
      while (true) {
        const status = yield* agent.status
        if (status.turn === "idle") return
        yield* Effect.yieldNow
      }
    })
    /** Wait for the turn to be reported finished, then return what the person got. */
    const sent = Effect.gen(function* () {
      while (!(yield* Ref.get(reports)).some((report) => report._tag === "Turn" && report.state === "finished")) {
        yield* Effect.yieldNow
      }
      return (yield* Ref.get(reports)).filter((report) => report._tag === "Question" || report._tag === "Message")
    })
    return { turns, log, reports, inbox, agent, outreach, logged, idle, sent }
  })

describe("Agent", () => {
  it.effect("runs a turn with what was queued and reports it", () =>
    Effect.gen(function* () {
      const { turns, inbox, logged, reports, idle } = yield* setup()
      yield* Queue.offer(turns, () => Effect.succeed(completed()))
      yield* inbox.deliver([userMessage(1, "Make the charts bigger")], "America/Los_Angeles")
      const [entry] = yield* logged(1)
      assert.include(entry, "What woke you:")
      assert.include(entry, "> Make the charts bigger")
      assert.include(entry, "(America/Los_Angeles)")
      yield* idle
      while ((yield* Ref.get(reports)).length < 2) yield* Effect.yieldNow
      assert.deepStrictEqual(
        (yield* Ref.get(reports)).map((report) =>
          report._tag === "Turn" ? `${report.state} ${report.eventIds}` : "usage"
        ),
        ["started evt_1", "finished evt_1"]
      )
      assert.strictEqual((yield* inbox.state).entries.length, 0)
    }).pipe(Effect.scoped)
  )

  it.effect("reports what a turn used when it finishes, failed or not", () =>
    Effect.gen(function* () {
      const { turns, inbox, reports, idle } = yield* setup()
      const used: TurnUsage = {
        tokens: { input: 203, cacheRead: 320_000, cacheWrite: 32_000, output: 3_020 },
        costUsd: 0.5,
        subagents: "included"
      }
      yield* Queue.offer(turns, () =>
        Effect.succeed({ ...completed(), outcome: TurnOutcome.Failed({ message: "crashed" }), turnUsage: used })
      )
      yield* inbox.deliver([userMessage(1)])
      yield* idle
      while ((yield* Ref.get(reports)).filter((report) => report._tag === "Turn").length < 2) yield* Effect.yieldNow
      const [started, finished] = (yield* Ref.get(reports)).filter((report) => report._tag === "Turn")
      assert.isUndefined(started?._tag === "Turn" ? started.usage : "missing")
      assert.deepStrictEqual(finished?._tag === "Turn" ? finished.usage : undefined, used)
    }).pipe(Effect.scoped)
  )

  it.effect("looks at the published URL after a completed turn", () =>
    Effect.gen(function* () {
      const checks = yield* Ref.make(0)
      const { turns, inbox, idle, reports } = yield* setup({
        published: Layer.succeed(Published, {
          port: Effect.succeed(Option.none()),
          noted: () => Effect.void,
          checkAfterTurn: Ref.update(checks, (n) => n + 1)
        })
      })
      yield* Queue.offer(turns, () => Effect.succeed(completed()))
      yield* inbox.deliver([userMessage(1)])
      while ((yield* Ref.get(checks)) === 0) yield* Effect.yieldNow
      yield* idle
      assert.isTrue((yield* Ref.get(reports)).some((report) => report._tag === "Turn" && report.state === "finished"))
      assert.strictEqual(yield* Ref.get(checks), 1)
    })
  )

  it.effect("hands events that arrive mid-turn to the running turn", () =>
    Effect.gen(function* () {
      const { turns, inbox, logged, reports, idle } = yield* setup()
      const release = yield* Deferred.make<void>()
      yield* Queue.offer(turns, () => Deferred.await(release).pipe(Effect.as(completed())))
      yield* inbox.deliver([userMessage(1)])
      yield* logged(1)
      yield* inbox.deliver([userMessage(2, "Also dark mode")])
      const log = yield* logged(2)
      assert.include(log[1], "steer: ")
      assert.include(log[1], "This arrived while you were working:")
      assert.include(log[1], "> Also dark mode")
      yield* Deferred.succeed(release, undefined)
      yield* idle
      while (!(yield* Ref.get(reports)).some((report) => report._tag === "Turn" && report.state === "finished")) {
        yield* Effect.yieldNow
      }
      const finished = (yield* Ref.get(reports)).find((report) => report._tag === "Turn" && report.state === "finished")
      assert.deepStrictEqual<ReadonlyArray<string>>(finished?._tag === "Turn" ? finished.eventIds : [], [
        "evt_1",
        "evt_2"
      ])
      assert.strictEqual((yield* inbox.state).entries.length, 0)
    }).pipe(Effect.scoped)
  )

  it.effect("starts another turn when the running one can't take new events", () =>
    Effect.gen(function* () {
      const { turns, inbox, logged } = yield* setup({ steerable: false })
      const release = yield* Deferred.make<void>()
      yield* Queue.offer(turns, () => Deferred.await(release).pipe(Effect.as(completed())))
      yield* Queue.offer(turns, () => Effect.succeed(completed()))
      yield* inbox.deliver([userMessage(1)])
      yield* logged(1)
      yield* inbox.deliver([userMessage(2, "Also dark mode")])
      yield* Deferred.succeed(release, undefined)
      const log = yield* logged(2)
      assert.include(log[1], "turn: ")
      assert.include(log[1], "> Also dark mode")
    }).pipe(Effect.scoped)
  )

  it.effect("retries a turn that failed before doing anything, after a backoff", () =>
    Effect.gen(function* () {
      const { turns, inbox, log, logged } = yield* setup()
      yield* Queue.offer(turns, () =>
        Effect.succeed({ outcome: TurnOutcome.Failed({ message: "401" }), usage: {}, progressed: false })
      )
      yield* Queue.offer(turns, () => Effect.succeed(completed()))
      yield* inbox.deliver([userMessage(1, "hello")])
      yield* logged(1)
      // The loop sleeps for the backoff after recording the failure; move the clock until it has.
      while ((yield* Ref.get(log)).length < 2) {
        yield* TestClock.adjust("1 second")
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2)))
      }
      assert.isAtLeast(yield* Clock.currentTimeMillis, Duration.toMillis(backoff(1)))
      assert.include((yield* Ref.get(log))[1], "> hello")
    }).pipe(Effect.scoped)
  )

  it.effect("stops at a usage limit and waits for the reset", () =>
    Effect.gen(function* () {
      const { turns, inbox, log, logged, reports } = yield* setup()
      const until = DateTime.add(yield* DateTime.now, { hours: 2 })
      yield* Queue.offer(turns, () =>
        Effect.succeed({
          outcome: TurnOutcome.Failed({ message: "limit" }),
          usage: { fiveHour: { usedPercent: 100 }, limit: { window: "fiveHour" as const, until } },
          progressed: false
        })
      )
      yield* Queue.offer(turns, () => Effect.succeed(completed()))
      yield* inbox.deliver([userMessage(1, "first, never handled")])
      yield* logged(1)
      while (!(yield* Ref.get(reports)).some((report) => report._tag === "Usage")) yield* Effect.yieldNow
      const usage = (yield* Ref.get(reports)).find((report) => report._tag === "Usage")
      assert.strictEqual(
        usage?._tag === "Usage" && usage.usage.limitedUntil && DateTime.formatIso(usage.usage.limitedUntil.until),
        DateTime.formatIso(until)
      )

      // A message during the limit waits…
      yield* inbox.deliver([userMessage(2, "still there?")])
      yield* TestClock.adjust("1 hour")
      assert.strictEqual((yield* Ref.get(log)).length, 1)
      // …until the reset arrives.
      yield* inbox.deliver([usageReset(3)])
      const after = yield* logged(2)
      assert.include(after[1], "> first, never handled")
      assert.include(after[1], "> still there?")
      assert.include(after[1], "Their five-hour usage window has reset.")
    }).pipe(Effect.scoped)
  )

  describe("when the agent talks where the person can't see", () => {
    it.effect("posts the final text of a turn that sent nothing, once", () =>
      Effect.gen(function* () {
        const { turns, inbox, sent } = yield* setup()
        yield* Queue.offer(turns, () => Effect.succeed(saying("  What's the priority — fast or polished?\n")))
        yield* inbox.deliver([userMessage(1, "Build me a band site")])
        assert.deepStrictEqual(yield* sent, [{ _tag: "Message", text: "What's the priority — fast or polished?" }])
      }).pipe(Effect.scoped)
    )

    it.effect("leaves the final text alone when the turn sent them something", () =>
      Effect.gen(function* () {
        const { turns, inbox, outreach, sent } = yield* setup()
        yield* Queue.offer(turns, () =>
          // `dream message` went through the CLI socket during the turn.
          outreach.record(["SendMessage"]).pipe(Effect.as(saying("I've sent them the plan.")))
        )
        yield* inbox.deliver([userMessage(1)])
        assert.deepStrictEqual(yield* sent, [])
      }).pipe(Effect.scoped)
    )

    it.effect("doesn't count calls that don't reach the person", () =>
      Effect.gen(function* () {
        const { turns, inbox, outreach, sent } = yield* setup()
        yield* Queue.offer(turns, () =>
          outreach.record(["ListWakes", "GetStatus"]).pipe(Effect.as(saying("Here's what's scheduled.")))
        )
        yield* inbox.deliver([userMessage(1)])
        assert.deepStrictEqual(yield* sent, [{ _tag: "Message", text: "Here's what's scheduled." }])
      }).pipe(Effect.scoped)
    )

    it.effect("doesn't post for turns only the agent's own doings started", () =>
      Effect.gen(function* () {
        const { turns, inbox, reports, sent } = yield* setup()
        const at = DateTime.makeUnsafe("2026-11-05T10:00:00Z")
        const agentOnly: ReadonlyArray<AgentEvent> = [
          AgentEvent.cases.Alert.make({ id: "evt_a" as EventId, at, reason: "scraper threw" }),
          AgentEvent.cases.PublishedUrlBroken.make({
            id: "evt_b" as EventId,
            at,
            url: "https://lift-log-x7k2.omer.build",
            port: 5173,
            facts: "Loaded it from this sandbox in Chromium: 403 text/plain"
          }),
          AgentEvent.cases.WakeDue.make({
            id: "evt_c" as EventId,
            at,
            wakeId: "wak_1" as WakeId,
            why: "check the scraper",
            run: { command: "node scrape.js", result: { exitCode: 1, outputTail: "Error" } }
          })
        ]
        yield* Queue.offer(turns, () => Effect.succeed(saying("Fixed the host check; it answers 200 now.")))
        yield* inbox.deliver(agentOnly)
        assert.deepStrictEqual(yield* sent, [])
        // One thing they did among them is enough to keep the safety net.
        yield* Ref.set(reports, [])
        yield* Queue.offer(turns, () => Effect.succeed(saying("The charts are bigger now.")))
        yield* inbox.deliver([
          AgentEvent.cases.Alert.make({ id: "evt_d" as EventId, at, reason: "again" }),
          userMessage(1, "Bigger charts?")
        ])
        assert.deepStrictEqual(yield* sent, [{ _tag: "Message", text: "The charts are bigger now." }])
      }).pipe(Effect.scoped)
    )

    it.effect("skips empty and boilerplate final text", () =>
      Effect.gen(function* () {
        const { turns, inbox, reports, sent } = yield* setup()
        yield* Queue.offer(turns, () => Effect.succeed(saying("No response requested.")))
        yield* inbox.deliver([userMessage(1)])
        assert.deepStrictEqual(yield* sent, [])
        yield* Ref.set(reports, [])
        yield* Queue.offer(turns, () => Effect.succeed(saying("  \n")))
        yield* inbox.deliver([userMessage(2)])
        assert.deepStrictEqual(yield* sent, [])
      }).pipe(Effect.scoped)
    )

    it.effect("doesn't post the text of a turn that failed", () =>
      Effect.gen(function* () {
        const { turns, inbox, sent } = yield* setup()
        yield* Queue.offer(turns, () =>
          Effect.succeed({ ...saying("Halfway through the"), outcome: TurnOutcome.Failed({ message: "crashed" }) })
        )
        yield* inbox.deliver([userMessage(1)])
        assert.deepStrictEqual(yield* sent, [])
      }).pipe(Effect.scoped)
    )

    it.effect("sends questions asked through the harness, and they count as reaching the person", () =>
      Effect.gen(function* () {
        const { turns, inbox, sent } = yield* setup()
        const outcome = yield* Deferred.make<unknown>()
        yield* Queue.offer(turns, (_, handlers) =>
          handlers.ask({ question: "Fast or polished?", options: ["Fast", "Polished"], why: "Priority" }).pipe(
            Effect.flatMap((result) => Deferred.succeed(outcome, result)),
            Effect.as(saying("I asked them about the priority."))
          )
        )
        yield* inbox.deliver([userMessage(1)])
        assert.deepStrictEqual(yield* sent, [
          {
            _tag: "Question",
            question: { question: "Fast or polished?", options: ["Fast", "Polished"], why: "Priority" }
          }
        ])
        assert.deepStrictEqual(yield* Deferred.await(outcome), { _tag: "Sent", messageId: "msg_2" })
      }).pipe(Effect.scoped)
    )
  })
})

describe("Agent with attachments", () => {
  const photoBytes = new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9])
  const photo: Attachment = {
    id: "med_photo" as MediaId,
    name: "IMG_0042.jpg",
    contentType: "image/jpeg",
    sizeBytes: photoBytes.length
  }
  const gone: Attachment = { id: "med_gone" as MediaId, name: "menu.pdf", contentType: "application/pdf", sizeBytes: 4 }

  /** A Worker serving one attachment to the project token; it counts what it was asked for. */
  const worker = Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly url: string; readonly asked: Array<string>; readonly server: Server }>((resolve) => {
          const asked: Array<string> = []
          const server = createServer((request, response) => {
            asked.push(`${request.url} ${request.headers.authorization}`)
            if (
              request.url === "/sandbox/attachments/med_photo" &&
              request.headers.authorization === "Bearer project-token"
            ) {
              response.writeHead(200, { "content-type": "image/jpeg" }).end(photoBytes)
            } else response.writeHead(404).end("Not found.")
          }).listen(0, "127.0.0.1", () =>
            resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, server })
          )
        })
    ),
    ({ server }) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
  )

  it.live(
    "copies them into the sandbox before the turn, and names where they are",
    () =>
      Effect.gen(function* () {
        const api = yield* worker
        const dir = tempDir()
        const { turns, inbox, log } = yield* setup({ attachments: { apiUrl: api.url, dir } })
        // Waits with real sleeps, so the HTTP server gets to answer.
        const logged = (n: number) =>
          Effect.gen(function* () {
            while ((yield* Ref.get(log)).length < n) yield* Effect.sleep("20 millis")
            return yield* Ref.get(log)
          })
        yield* Queue.offer(turns, () => Effect.succeed(completed()))
        yield* inbox.deliver([{ ...userMessage(1, "The whiteboard and the menu"), attachments: [photo, gone] }])
        const [prompt] = yield* logged(1)
        const landed = join(dir, ".dream", "attachments", "msg_1", "IMG_0042.jpg")
        assert.deepStrictEqual(new Uint8Array(readFileSync(landed)), photoBytes)
        assert.include(prompt, "They attached 2 files:")
        assert.include(prompt, "- /home/user/.dream/attachments/msg_1/IMG_0042.jpg (photo, 6 bytes)")
        assert.include(prompt, "- menu.pdf (application/pdf, 4 bytes), which Dream couldn't copy into the sandbox")
        assert.isFalse(existsSync(join(dir, ".dream", "attachments", "msg_1", "menu.pdf")))

        // A later turn with the same message doesn't fetch what's already there.
        const before = api.asked.filter((line) => line.includes("med_photo")).length
        yield* Queue.offer(turns, () => Effect.succeed(completed()))
        yield* inbox.deliver([{ ...userMessage(2, "again"), messageId: "msg_1" as never, attachments: [photo] }])
        yield* logged(2)
        assert.strictEqual(api.asked.filter((line) => line.includes("med_photo")).length, before)
      }).pipe(Effect.scoped),
    20_000
  )
})
