/**
 * Relays through the whole control plane, in memory: the agent asks over SandboxRpcs, the ProjectDO keeps the list
 * and resolves the key, a RelayDO holds the line to a fake Discord (or feed), and its events reach the app through
 * the fake dreamd. Plus the early sleep after scheduled work.
 */
import { assert, describe, it } from "@effect/vitest"
import { DaemonEnvFile, DiscordDefaultIntents, type IntegrationId, type ProjectId, RelaySource } from "@dream/domain"
import { Context, DateTime, Duration, Effect, Exit, Redacted } from "effect"
import { Core } from "../src/project/Core.ts"
import { Store } from "../src/project/Store.ts"
import { RelayRuntime } from "../src/relay/Runtime.ts"
import { makeCloud } from "./support/Cloud.ts"

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
const claudeToken = `sk-ant-oat01-${"y".repeat(60)}`

/** Signs in, connects Claude, creates a project, and wakes it once so it has a sandbox and dreamd a token. */
const setup = (cloud: Cloud) =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({
      email: "omer@example.com",
      name: "Omer",
      secret: Redacted.make("dev-secret")
    })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
    cloud.world.scripts.set("claude setup-token", [
      { _tag: "Output", text: `Use the url below\r\n${claudeUrl}\r\n` },
      { _tag: "Output", text: "Paste code here if prompted > " }
    ])
    const started = yield* cloud.phone.StartModelConnection({ provider: "claude" })
    cloud.world.attachOutput = [{ _tag: "Output", text: `Your OAuth token (valid for 1 year):\r\n${claudeToken}\r\n` }]
    yield* cloud.phone.CompleteModelConnection({
      connectionId: started.connection.id,
      code: Redacted.make("code#state")
    })
    const project = yield* cloud.phone.CreateProject({ idea: "A Discord bot that answers questions about our club." })
    yield* cloud.alarm(project.id)
    const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === project.id)!
    const env = Object.fromEntries(
      sandbox.files
        .get(DaemonEnvFile)!
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), JSON.parse(line.slice(line.indexOf("=") + 1))])
    )
    const dreamd = yield* cloud.sandbox(env.DREAM_PROJECT_TOKEN)
    return { project, dreamd, sandbox }
  })

/** Connects a Discord bot key the way the agent asks for one, and returns its integration id. */
const connectDiscordKey = (
  cloud: Cloud,
  project: { readonly id: ProjectId },
  dreamd: Dreamd,
  key = "discord-bot-token"
) =>
  Effect.gen(function* () {
    const request = yield* dreamd.RequestAccess({
      request: { _tag: "Key", service: "Discord", host: "discord.com", header: "Authorization", format: "Bot {key}" },
      why: "Add your Discord bot key so it can answer in your server"
    })
    yield* cloud.phone.SubmitKeyAccess({ projectId: project.id, messageId: request.id, key: Redacted.make(key) })
    return (yield* cloud.phone.ListIntegrations()).find((integration) => integration.label === "Discord")!.id
  })

type Dreamd = Effect.Success<ReturnType<Cloud["sandbox"]>>

const discord = (overrides: Partial<Extract<RelaySource, { _tag: "Discord" }>> = {}) =>
  RelaySource.cases.Discord.make({
    intents: DiscordDefaultIntents,
    events: ["MESSAGE_CREATE"],
    mentionsOnly: false,
    ...overrides
  })

/** Polls `check` until it holds, for up to five seconds. */
const eventually = <A, E>(check: Effect.Effect<A, E>, holds: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const value = yield* check
      if (holds(value)) return value
      yield* Effect.sleep("50 millis")
    }
    return yield* Effect.die(new Error(`never held; last value: ${JSON.stringify(yield* check)}`))
  })

describe("relays", () => {
  it.live("a Discord relay needs their bot key, then holds the line and posts each message to the app", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const refused = yield* Effect.flip(
        dreamd.AddRelay({ source: discord(), target: { path: "/hooks/discord", port: 3000 } })
      )
      assert.strictEqual(refused._tag, "InvalidRequest")
      assert.include(
        refused.message,
        'dream access key --service Discord --host discord.com --header Authorization --format "Bot {key}"'
      )

      const keyId = yield* connectDiscordKey(cloud, project, dreamd)
      const added = yield* dreamd.AddRelay({
        source: discord({ mentionsOnly: true }),
        target: { path: "/hooks/discord", port: 3000 },
        label: "club bot"
      })
      assert.strictEqual(added.label, "club bot")
      assert.strictEqual(added.source._tag === "Discord" && added.source.integrationId, keyId)
      const listed = yield* eventually(dreamd.ListRelays(), (all) => all[0]?.state === "connected")
      assert.strictEqual(listed[0]?.account, "Helper")
      assert.include(cloud.discord.calls, `identify ${DiscordDefaultIntents}`)

      cloud.discord.message("not for the bot")
      cloud.discord.message("@Helper when's the next meetup?", { mentionsBot: true })
      const forwards = yield* eventually(
        Effect.sync(() => cloud.world.relayForwards),
        (all) => all.length > 0
      )
      assert.deepStrictEqual(
        forwards.map(({ relayId, port, path, ids }) => ({ relayId, port, path, count: ids.length })),
        [{ relayId: added.id, port: 3000, path: "/hooks/discord", count: 1 }]
      )
      const after = yield* eventually(dreamd.ListRelays(), (all) => all[0]?.delivered === 1)
      assert.strictEqual(after[0]?.waiting, 0)
      // The token went to Discord and nowhere the agent can see.
      assert.notInclude(JSON.stringify(after), "discord-bot-token")
      assert.notInclude(JSON.stringify(cloud.world.relayForwards), "discord-bot-token")
      yield* cloud.close
    })
  )

  it.live("delivers to the published port unless the relay names one, and refuses one with nowhere to deliver", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      yield* connectDiscordKey(cloud, project, dreamd)
      const nowhere = yield* Effect.flip(dreamd.AddRelay({ source: discord(), target: { path: "/hooks/discord" } }))
      assert.include(nowhere.message, "publish your app's port first, or give the relay --port")
      yield* dreamd.Publish({ port: 8080 })
      yield* dreamd.AddRelay({ source: discord(), target: { path: "/hooks/discord" } })
      yield* eventually(dreamd.ListRelays(), (all) => all[0]?.state === "connected")
      cloud.discord.message("hi")
      const [forward] = yield* eventually(
        Effect.sync(() => cloud.world.relayForwards),
        (all) => all.length > 0
      )
      assert.strictEqual(forward?.port, 8080)
      yield* cloud.close
    })
  )

  it.live("a feed's key has to be for the feed's host, and a project holds three relays at most", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const stripe = yield* dreamd.RequestAccess({
        request: {
          _tag: "Key",
          service: "Stripe",
          host: "api.stripe.com",
          header: "Authorization",
          format: "Bearer {key}"
        },
        why: "Take payments"
      })
      yield* cloud.phone.SubmitKeyAccess({
        projectId: project.id,
        messageId: stripe.id,
        key: Redacted.make("sk_live_1")
      })
      const stripeId = (yield* cloud.phone.ListIntegrations()).find((i) => i.label === "Stripe")!.id as IntegrationId
      const feed = (integrationId?: IntegrationId) =>
        RelaySource.cases.WebSocket.make({
          url: "wss://feed.example.test/prices",
          send: ['{"subscribe":"BTC"}'],
          ...(integrationId === undefined ? {} : { integrationId })
        })
      const wrongHost = yield* Effect.flip(
        dreamd.AddRelay({ source: feed(stripeId), target: { path: "/f", port: 3000 } })
      )
      assert.include(wrongHost.message, "is a key for api.stripe.com, so it can't go to feed.example.test")
      // And a Stripe key can't log a Discord bot in.
      const notDiscord = yield* Effect.flip(
        dreamd.AddRelay({ source: discord({ integrationId: stripeId }), target: { path: "/d", port: 3000 } })
      )
      assert.include(notDiscord.message, "not discord.com")

      for (let i = 0; i < 3; i++) yield* dreamd.AddRelay({ source: feed(), target: { path: `/f${i}`, port: 3000 } })
      const fourth = yield* Effect.flip(dreamd.AddRelay({ source: feed(), target: { path: "/f3", port: 3000 } }))
      assert.include(fourth.message, "A project can have 3 relays")
      yield* eventually(
        Effect.sync(() => cloud.feed.connections.length),
        (n) => n === 3
      )
      assert.deepStrictEqual(cloud.feed.connections[0]?.received, ['{"subscribe":"BTC"}'])
      yield* cloud.close
    })
  )

  it.live("removing one closes its line; archiving stops them all, restoring starts them, deleting stops them", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      yield* connectDiscordKey(cloud, project, dreamd)
      const first = yield* dreamd.AddRelay({ source: discord(), target: { path: "/hooks/discord", port: 3000 } })
      yield* eventually(
        Effect.sync(() => cloud.discord.connected),
        (n) => n === 1
      )
      yield* dreamd.RemoveRelay({ relayId: first.id })
      yield* eventually(
        Effect.sync(() => cloud.discord.connected),
        (n) => n === 0
      )
      assert.deepStrictEqual(yield* dreamd.ListRelays(), [])
      const missing = yield* Effect.flip(dreamd.RemoveRelay({ relayId: first.id }))
      assert.strictEqual(missing._tag, "NotFound")

      const second = yield* dreamd.AddRelay({ source: discord(), target: { path: "/hooks/discord", port: 3000 } })
      yield* eventually(
        Effect.sync(() => cloud.discord.connected),
        (n) => n === 1
      )
      yield* cloud.phone.ArchiveProject({ projectId: project.id })
      yield* eventually(
        Effect.sync(() => cloud.discord.connected),
        (n) => n === 0
      )
      const relayObject = yield* Effect.promise(() => cloud.relay(second.id))
      assert.isTrue(Exit.isFailure(yield* Effect.exit(Context.get(relayObject.context, RelayRuntime).status)))

      yield* cloud.phone.RestoreProject({ projectId: project.id })
      yield* eventually(
        Effect.sync(() => cloud.discord.connected),
        (n) => n === 1
      )
      assert.strictEqual((yield* dreamd.ListRelays())[0]?.id, second.id)

      yield* cloud.phone.DeleteProject({ projectId: project.id })
      yield* eventually(
        Effect.sync(() => cloud.discord.connected),
        (n) => n === 0
      )
      yield* cloud.close
    })
  )

  it.live("a relay that fails tells the agent, and a replaced key starts it again", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const keyId = yield* connectDiscordKey(cloud, project, dreamd, "an-old-token")
      const added = yield* dreamd.AddRelay({ source: discord(), target: { path: "/hooks/discord", port: 3000 } })
      const failed = yield* eventually(dreamd.ListRelays(), (all) => all[0]?.state === "failed")
      assert.include(failed[0]?.problems[0]?.message, "Discord refused the bot token (4004)")
      yield* cloud.alarm(project.id)
      const alert = cloud.world.delivered
        .flatMap((delivery) => delivery.events as ReadonlyArray<{ _tag: string; reason?: string }>)
        .find((event) => event._tag === "Alert")
      assert.include(alert?.reason, `Relay ${added.id} (Discord) stopped: Discord refused the bot token (4004)`)

      yield* cloud.phone.ReplaceKey({ integrationId: keyId, key: Redacted.make("discord-bot-token") })
      const back = yield* eventually(dreamd.ListRelays(), (all) => all[0]?.state === "connected")
      assert.strictEqual(back[0]?.id, added.id)
      yield* cloud.close
    })
  )

  it.live("a relay delivery wakes a sleeping sandbox", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd, sandbox } = yield* setup(cloud)
      yield* connectDiscordKey(cloud, project, dreamd)
      yield* dreamd.AddRelay({ source: discord(), target: { path: "/hooks/discord", port: 3000 } })
      yield* eventually(dreamd.ListRelays(), (all) => all[0]?.state === "connected")
      sandbox.state = "paused"
      const resumes = sandbox.resumes
      cloud.discord.message("wake up")
      yield* eventually(
        Effect.sync(() => cloud.world.relayForwards.length),
        (n) => n === 1
      )
      assert.strictEqual(sandbox.state, "running")
      assert.strictEqual(sandbox.resumes, resumes + 1)
      yield* cloud.close
    })
  )
})

describe("going back to sleep after scheduled work", () => {
  /** A project whose first turn ran and ended more than five minutes ago, so nothing holds its sandbox up. */
  const idle = (cloud: Cloud) =>
    Effect.gen(function* () {
      const { project, dreamd, sandbox } = yield* setup(cloud)
      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      yield* dreamd.ReportTurn({ state: "finished", eventIds: [] })
      const instance = yield* Effect.promise(() => cloud.project(project.id))
      const core = Context.get(instance.context, Core)
      const record = yield* core.sandbox
      const earlier = DateTime.subtract(yield* DateTime.now, { minutes: 6 })
      yield* core.saveSandbox({
        ...record,
        turnEndedAt: earlier,
        awakeUntil: DateTime.addDuration(earlier, Duration.minutes(5))
      })
      // dreamd looks a few seconds after its work is done, by which time the last delivery is behind it.
      yield* Effect.sleep("2500 millis")
      return { project, dreamd, sandbox, core, instance }
    })

  it.live("pauses the sandbox at once when dreamd has nothing left and Dream has nothing on its way", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { dreamd, sandbox } = yield* idle(cloud)
      const pauses = sandbox.pauses
      yield* dreamd.Sleep({ reason: "command", checkedAt: yield* DateTime.now })
      assert.strictEqual(sandbox.state, "paused")
      assert.strictEqual(sandbox.pauses, pauses + 1)
      yield* cloud.close
    })
  )

  it.live(
    "doesn't when a turn runs, events wait, a turn just ended, or dreamd was handed something after it looked",
    () =>
      Effect.gen(function* () {
        const cloud = yield* makeCloud()
        const { project, dreamd, sandbox, core, instance } = yield* idle(cloud)
        const asleep = () => sandbox.state === "paused"

        // dreamd looked before Dream handed it the last delivery (the project's first events).
        yield* dreamd.Sleep({ reason: "command", checkedAt: DateTime.subtract(yield* DateTime.now, { minutes: 10 }) })
        assert.isFalse(asleep())

        yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
        yield* dreamd.Sleep({ reason: "command", checkedAt: yield* DateTime.now })
        assert.isFalse(asleep())
        yield* dreamd.ReportTurn({ state: "finished", eventIds: [] })
        // Just ended: the few minutes after a turn stay.
        yield* dreamd.Sleep({ reason: "command", checkedAt: yield* DateTime.now })
        assert.isFalse(asleep())

        const record = yield* core.sandbox
        const earlier = DateTime.subtract(yield* DateTime.now, { minutes: 6 })
        yield* core.saveSandbox({ ...record, awakeUntil: DateTime.addDuration(earlier, Duration.minutes(5)) })
        yield* dreamd.WakeNow({ why: "the app logged an error" })
        yield* dreamd.Sleep({ reason: "command", checkedAt: yield* DateTime.now })
        assert.isFalse(asleep())
        assert.strictEqual((yield* Context.get(instance.context, Store).pendingEvents(10)).length, 1)

        // Archived: nothing to do here.
        yield* cloud.phone.ArchiveProject({ projectId: project.id })
        sandbox.state = "running"
        yield* dreamd.Sleep({ reason: "command", checkedAt: yield* DateTime.now }).pipe(Effect.ignore)
        assert.isFalse(asleep())
        yield* cloud.close
      })
  )
})
