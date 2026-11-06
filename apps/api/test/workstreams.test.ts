/**
 * Workstreams in the control plane: the agent starts, updates and ends them (`dream work`), labels what it sends,
 * and files their messages; the phone sees them on the Status card and writes into one.
 */
import { assert, describe, it } from "@effect/vitest"
import { type AgentEvent, DaemonEnvFile, type ProjectId, type Workstream, type WorkstreamId } from "@dream/domain"
import { DateTime, Effect, Fiber, Redacted, Stream } from "effect"
import { EndedWorkstreamsKept, pruneWorkstreams } from "../src/project/Handlers.ts"
import { makeCloud } from "./support/Cloud.ts"

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
const claudeToken = `sk-ant-oat01-${"x".repeat(60)}`

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const setup = (cloud: Cloud) =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({ email: "ada@example.com", secret: Redacted.make("dev-secret") })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
    cloud.world.scripts.set("claude setup-token", [
      { _tag: "Output", text: `Use the url below\r\n${claudeUrl}\r\n` },
      { _tag: "Output", text: "Paste code here if prompted > " }
    ])
    const started = yield* cloud.phone.StartModelConnection({ provider: "claude" })
    cloud.world.attachOutput = [
      { _tag: "Output", text: "Long-lived authentication token created successfully!\r\n" },
      { _tag: "Output", text: `${claudeToken}\r\n` }
    ]
    yield* cloud.phone.CompleteModelConnection({
      connectionId: started.connection.id,
      code: Redacted.make("code123#state")
    })
    const project = yield* cloud.phone.CreateProject({ idea: "A shared kitty for group trips." })
    yield* cloud.alarm(project.id)
    const dreamd = yield* cloud.sandbox(tokenOf(cloud, project.id))
    return { project, dreamd }
  })

const tokenOf = (cloud: Cloud, projectId: ProjectId): string => {
  const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  const line = sandbox.files
    .get(DaemonEnvFile)!
    .split("\n")
    .find((l) => l.startsWith("DREAM_PROJECT_TOKEN="))!
  return JSON.parse(line.slice("DREAM_PROJECT_TOKEN=".length))
}

const userMessages = (cloud: Cloud) =>
  cloud.world.delivered
    .flatMap((d) => d.events as ReadonlyArray<AgentEvent>)
    .filter((e): e is Extract<AgentEvent, { _tag: "UserMessage" }> => e._tag === "UserMessage")

describe("workstreams", () => {
  it.live("start, update and end, on the Status card the phone receives", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      assert.deepStrictEqual(yield* dreamd.ListWorkstreams(), { workstreams: [], waiting: [] })

      const live = yield* cloud.live(project.id)
      const changes = yield* live.Subscribe().pipe(
        Stream.filter((e) => e._tag === "StatusChanged"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.sleep("50 millis")
      const started = yield* dreamd.StartWorkstream({ title: "Double charges", now: "Reproducing it" })
      const charges = started.workstreams[0]!
      assert.strictEqual(charges.state, "active")
      assert.match(charges.id, /^ws_/)
      yield* dreamd.StartWorkstream({ title: "Trip screen redesign" })
      const statuses = yield* Fiber.join(changes)
      assert.deepStrictEqual(
        statuses.map((e) => (e._tag === "StatusChanged" ? (e.status.workstreams ?? []).map((w) => w.title) : [])),
        [["Double charges"], ["Double charges", "Trip screen redesign"]]
      )

      const updated = yield* dreamd.UpdateWorkstream({ workstreamId: charges.id, now: "Testing the fix" })
      assert.strictEqual(updated.workstreams[0]?.now, "Testing the fix")
      const cleared = yield* dreamd.UpdateWorkstream({ workstreamId: charges.id, now: null })
      assert.notProperty(cleared.workstreams[0]!, "now")

      const done = yield* dreamd.EndWorkstream({
        workstreamId: charges.id,
        state: "done",
        result: "Fixed, refunds sent"
      })
      const ended = done.workstreams[0]!
      assert.strictEqual(ended.state, "done")
      assert.strictEqual(ended.result, "Fixed, refunds sent")
      assert.isDefined(ended.endedAt)
      // Ending it again changes nothing.
      assert.deepStrictEqual(
        yield* dreamd.EndWorkstream({ workstreamId: charges.id, state: "done", result: "Other" }),
        done
      )
      // The rest of the card is left as it was.
      const status = yield* dreamd.UpdateStatus({ now: "Fixing double charges first" })
      assert.strictEqual(status.workstreams?.length, 2)

      const missing = yield* dreamd
        .UpdateWorkstream({ workstreamId: "ws_nope" as WorkstreamId, now: "x" })
        .pipe(Effect.flip)
      assert.strictEqual(missing._tag, "NotFound")
      yield* cloud.close
    })
  )

  it.live("labels what the agent sends, and a workstream waits while its question is open", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const trip = (yield* dreamd.StartWorkstream({ title: "Trip screen redesign" })).workstreams[0]!
      const sent = yield* dreamd.SendMessage({
        text: "Two mocks tonight.",
        media: [],
        notify: false,
        workstream: trip.id
      })
      assert.strictEqual(sent.workstream, trip.id)
      const asked = yield* dreamd.AskQuestion({
        question: "Which trip screen should I build?",
        options: ["Balance first", "Activity first"],
        workstream: trip.id
      })
      assert.strictEqual(asked.workstream, trip.id)
      const later = yield* dreamd.RequestAccess({
        request: { _tag: "Apple" },
        why: "Add your Apple Developer key to put Kitty on your phone.",
        when: "around Thursday",
        workstream: trip.id
      })
      assert.strictEqual(later.workstream, trip.id)
      // The question makes it wait; the access request for later doesn't yet.
      assert.deepStrictEqual((yield* dreamd.ListWorkstreams()).waiting, [{ workstream: trip.id, messageId: asked.id }])

      yield* cloud.phone.AnswerQuestion({
        projectId: project.id,
        messageId: asked.id,
        answer: { _tag: "Choice", option: "Activity first" }
      })
      assert.deepStrictEqual((yield* dreamd.ListWorkstreams()).waiting, [])

      const unknown = yield* dreamd
        .SendMessage({ text: "Hi", media: [], notify: false, workstream: "ws_nope" as WorkstreamId })
        .pipe(Effect.flip)
      assert.strictEqual(unknown._tag, "InvalidRequest")
      assert.include(unknown._tag === "InvalidRequest" ? unknown.message : "", "dream work list")
      const history = yield* cloud.phone.ListMessages({ projectId: project.id })
      assert.deepStrictEqual(
        history.messages.map((m) => m.workstream).filter((w) => w !== undefined),
        [trip.id, trip.id, trip.id]
      )
      yield* cloud.close
    })
  )

  it.live("their message into a workstream reaches the agent with it; the agent files the others", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const android = (yield* dreamd.StartWorkstream({ title: "Android?" })).workstreams[0]!

      const into = yield* cloud.phone.SendMessage({
        projectId: project.id,
        text: "Only if it doesn't slow down iPhone",
        workstream: android.id
      })
      assert.strictEqual(into.workstream, android.id)
      // One the agent doesn't have is left off; their words still go through.
      const stray = yield* cloud.phone.SendMessage({
        projectId: project.id,
        text: "Also the trip screen feels cramped",
        workstream: "ws_gone" as WorkstreamId
      })
      assert.notProperty(stray, "workstream")
      yield* cloud.alarm(project.id)
      const [, first, second] = userMessages(cloud)
      assert.deepStrictEqual(first?.workstream, { id: android.id, title: "Android?" })
      assert.strictEqual(first?.messageId, into.id)
      assert.notProperty(second!, "workstream")

      // The agent files their second message under a new workstream as it starts it, then moves it.
      const trip = (yield* dreamd.StartWorkstream({ title: "Trip screen redesign", from: stray.id })).workstreams.find(
        (w) => w.title === "Trip screen redesign"
      )!
      const listed = (yield* cloud.phone.ListMessages({ projectId: project.id })).messages
      const filed = listed.find((m) => m.id === stray.id)
      assert.strictEqual(filed?.workstream, trip.id)
      const moved = yield* dreamd.RouteMessage({ messageId: stray.id, workstreamId: android.id })
      assert.strictEqual(moved.workstream, android.id)
      const nowhere = yield* dreamd
        .RouteMessage({ messageId: stray.id, workstreamId: "ws_nope" as WorkstreamId })
        .pipe(Effect.flip)
      assert.strictEqual(nowhere._tag, "NotFound")
      yield* cloud.close
    })
  )

  it.live("refuses to put one of the project's file keys on a row", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const card = yield* dreamd.RequestAccess({
        request: { _tag: "File", service: "Telegram", name: "telegram-bot-token" },
        why: "Connect your Telegram bot."
      })
      const fakeKey = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
      yield* cloud.phone.SubmitKeyAccess({ projectId: project.id, messageId: card.id, key: Redacted.make(fakeKey) })
      const leak = yield* dreamd.StartWorkstream({ title: "Bot", now: `Using ${fakeKey}` }).pipe(Effect.flip)
      assert.strictEqual(leak._tag, "InvalidRequest")
      yield* cloud.close
    })
  )

  it("keeps the latest ended workstreams and every active one", () => {
    const at = (minutes: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 4, 12, minutes))
    const make = (i: number, state: Workstream["state"]): Workstream => ({
      id: `ws_${i}` as WorkstreamId,
      title: `W${i}`,
      state,
      startedAt: at(0),
      updatedAt: at(i),
      ...(state === "active" ? {} : { endedAt: at(i) })
    })
    const list = [
      ...Array.from({ length: EndedWorkstreamsKept + 5 }, (_, i) => make(i, i % 2 === 0 ? "done" : "dropped")),
      make(99, "active")
    ]
    const kept = pruneWorkstreams(list)
    assert.strictEqual(kept.length, EndedWorkstreamsKept + 1)
    assert.isTrue(kept.some((w) => w.id === ("ws_99" as WorkstreamId)))
    assert.isFalse(kept.some((w) => w.id === ("ws_0" as WorkstreamId)))
  })
})
