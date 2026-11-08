/**
 * The relays a project holds (see `@dream/domain` `Relay.ts`). The ProjectDO keeps the list, each relay as the agent
 * asked for it with its key resolved; one RelayDO per relay holds the line and keeps its state. This service:
 *
 * - adds, lists, removes and restarts relays for the agent (`SandboxRpcs.*Relay`),
 * - answers its RelayDOs (`ProjectRpcs.Relay*`): hands their events to dreamd, decrypts their key, passes on what
 *   the agent should hear, and says whether a relay is still wanted,
 * - stops them all when the project is archived or deleted, and starts them again on restore,
 * - and restarts failed relays when the key they use is connected again.
 *
 * A relay's key is one of their `Key` integrations: for Discord, the one for discord.com that their REST calls
 * already use; for a feed, one whose host is the feed's. The value is decrypted here, inside the Worker, and only
 * when the RelayDO opens its line.
 */
import {
  type Integration,
  InvalidRequest,
  NotFound,
  type Relay,
  type RelayForward,
  type RelayForwardResult,
  type RelayId,
  RelaysPerProject,
  type RelaySource,
  type RelayTarget,
  relayUrlHost
} from "@dream/domain"
import { Clock, Context, DateTime, Effect, Layer, Option, Redacted } from "effect"
import { Connections, type IntegrationRow } from "../db/Connections.ts"
import { toHex, utf8 } from "../lib/Bytes.ts"
import { CredentialStore } from "../integrations/CredentialStore.ts"
import { newEventId, newRelayId } from "../lib/Ids.ts"
import { RelayClients } from "../relay/RelayClients.ts"
import type { RelayConfig, RelayStatus } from "../relay/RelayRpcs.ts"
import { AgentEvent } from "@dream/domain"
import { Core } from "./Core.ts"
import { ProjectLog } from "./ProjectLog.ts"
import type { RelayCredential } from "./ProjectRpcs.ts"
import { SandboxManager } from "./SandboxManager.ts"
import { type RelayRecord, Singletons, Store } from "./Store.ts"

const isDiscordHost = (host: string) =>
  host.toLowerCase() === "discord.com" || host.toLowerCase().endsWith(".discord.com")

/** Whether a `Key` integration is for Discord's API, and so holds a bot token. */
export const isDiscordKey = (row: IntegrationRow): boolean =>
  row.access_json._tag === "Key" && isDiscordHost(row.access_json.host)

const discordKeyRequest =
  'dream access key --service Discord --host discord.com --header Authorization --format "Bot {key}"'

/** What a relay looks like when its RelayDO can't be asked. */
const unknownStatus = (message: string, at: DateTime.Utc): RelayStatus => ({
  state: "retrying",
  waiting: 0,
  delivered: 0,
  dropped: 0,
  problems: [{ at, message }]
})

const fingerprint = (key: string): Effect.Effect<string> =>
  Effect.promise(async () => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(key)))))

const toRelay = (record: RelayRecord, status: RelayStatus): Relay => ({
  id: record.id,
  ...(record.label === undefined ? {} : { label: record.label }),
  source: record.source,
  target: record.target,
  createdAt: record.createdAt,
  ...status
})

export class Relays extends Context.Service<
  Relays,
  {
    readonly add: (request: {
      readonly source: RelaySource
      readonly target: RelayTarget
      readonly label?: string | undefined
    }) => Effect.Effect<Relay, InvalidRequest>
    readonly list: Effect.Effect<ReadonlyArray<Relay>>
    readonly remove: (id: RelayId) => Effect.Effect<void, NotFound>
    readonly restart: (id: RelayId) => Effect.Effect<Relay, NotFound>
    readonly deliver: (
      id: RelayId,
      deliveries: readonly [RelayForward, ...Array<RelayForward>]
    ) => Effect.Effect<RelayForwardResult, NotFound>
    readonly credential: (id: RelayId) => Effect.Effect<RelayCredential, NotFound | InvalidRequest>
    readonly alert: (id: RelayId, reason: string) => Effect.Effect<void, NotFound>
    readonly active: (id: RelayId) => Effect.Effect<boolean>
    /** Archived or deleted: every RelayDO closes its line and forgets. The list stays, for a restore. */
    readonly stopAll: Effect.Effect<void>
    /** Restored: every relay starts again. */
    readonly startAll: Effect.Effect<void>
    /** One of their integrations changed (connected again, replaced, removed): relays using it open afresh. */
    readonly integrationChanged: (integration: Integration) => Effect.Effect<void>
    /** Their credentials changed somewhere: relays whose key they replaced open afresh with the new one. */
    readonly keysChanged: Effect.Effect<void>
  }
>()("@dream/api/project/Relays") {
  static readonly layer = Layer.effect(
    Relays,
    Effect.gen(function* () {
      const core = yield* Core
      const projectLog = yield* ProjectLog
      const store = yield* Store
      const sandbox = yield* SandboxManager
      const connections = yield* Connections
      const credentials = yield* CredentialStore
      const clients = yield* RelayClients

      /** Deleted, or archived until they restore it: no relay runs. */
      const held = Effect.gen(function* () {
        if (Option.isSome(yield* store.getSingleton(...Singletons.deleted))) return true
        return Option.isSome(yield* store.getSingleton(...Singletons.archived))
      })

      const find = (id: RelayId) =>
        Effect.flatMap(store.relays, (all) => {
          const record = all.find((relay) => relay.id === id)
          return record === undefined ? Effect.fail(new NotFound({ entity: "relay", id })) : Effect.succeed(record)
        })

      const configFor = (record: RelayRecord) =>
        Effect.map(
          core.project.pipe(Effect.orDie),
          (project): RelayConfig => ({
            relayId: record.id,
            projectId: project.id,
            source: record.source,
            target: record.target,
            ...(record.label === undefined ? {} : { label: record.label }),
            createdAt: record.createdAt
          })
        )

      /** Asks a RelayDO; a RelayDO that can't be reached is reported as retrying, not as an error. */
      const ask = (id: RelayId, call: Effect.Effect<RelayStatus, unknown, never>) =>
        call.pipe(
          Effect.catchCause((cause) =>
            Effect.flatMap(DateTime.now, (now) =>
              Effect.logWarning("couldn't ask a relay how it's doing", { relay: id, cause }).pipe(
                Effect.as(unknownStatus("Dream couldn't reach this relay just now.", now))
              )
            )
          )
        )

      const start = (record: RelayRecord) =>
        Effect.flatMap(configFor(record), (config) =>
          ask(
            record.id,
            clients.use(record.id, (client) => client.Start({ config }))
          )
        )

      const stop = (id: RelayId) =>
        clients
          .use(id, (client) => client.Stop())
          .pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't stop a relay", { relay: id, cause })))

      /** The key a relay uses: their connected `Key` integration, checked against what the relay is for. */
      const resolveKey = (source: RelaySource) =>
        Effect.gen(function* () {
          const project = yield* core.project.pipe(Effect.orDie)
          const keys = (yield* connections.integrations(project.ownerId)).filter(
            (row) => row.status === "connected" && row.access_json._tag === "Key"
          )
          if (source._tag === "Discord") {
            const discord = keys.filter(isDiscordKey)
            if (source.integrationId !== undefined) {
              const named = keys.find((row) => row.id === source.integrationId)
              if (named === undefined) {
                return yield* new InvalidRequest({
                  message: `${source.integrationId} isn't one of their connected keys. \`dream access list\` shows them.`
                })
              }
              if (!isDiscordKey(named)) {
                return yield* new InvalidRequest({
                  message: `${source.integrationId} is a key for ${named.access_json._tag === "Key" ? named.access_json.host : "another service"}, not discord.com, so it can't log a bot in.`
                })
              }
              return named
            }
            const [only, ...more] = discord
            if (only === undefined) {
              return yield* new InvalidRequest({
                message: `There's no Discord bot key to log in with. Ask them for one first: ${discordKeyRequest}. The same key serves the bot's REST calls.`
              })
            }
            if (more.length > 0) {
              return yield* new InvalidRequest({
                message: `They have more than one Discord key (${discord.map((row) => row.id).join(", ")}); name one with --key.`
              })
            }
            return only
          }
          if (source.integrationId === undefined) return undefined
          const named = keys.find((row) => row.id === source.integrationId)
          if (named === undefined || named.access_json._tag !== "Key") {
            return yield* new InvalidRequest({
              message: `${source.integrationId} isn't one of their connected keys. \`dream access list\` shows them.`
            })
          }
          const host = relayUrlHost(source.url)
          if (host !== named.access_json.host.toLowerCase()) {
            return yield* new InvalidRequest({
              message: `${source.integrationId} is a key for ${named.access_json.host}, so it can't go to ${host ?? source.url}. A key only goes to its own host.`
            })
          }
          return named
        })

      const withKey = (source: RelaySource, key: IntegrationRow | undefined): RelaySource =>
        key === undefined ? source : { ...source, integrationId: key.id }

      const withoutKey = (source: RelaySource): RelaySource => {
        const { integrationId: _, ...rest } = source
        return rest as RelaySource
      }

      return Relays.of({
        add: ({ source, target, label }) =>
          Effect.gen(function* () {
            const existing = yield* store.relays
            if (existing.length >= RelaysPerProject) {
              return yield* new InvalidRequest({
                message: `A project can have ${RelaysPerProject} relays; remove one first (\`dream relay list\`).`
              })
            }
            const project = yield* core.project.pipe(Effect.orDie)
            if (target.port === undefined && project.publishedPort === undefined) {
              return yield* new InvalidRequest({
                message:
                  "Nothing's published to deliver to yet: publish your app's port first, or give the relay --port."
              })
            }
            const key = yield* resolveKey(source)
            const record: RelayRecord = {
              id: yield* newRelayId(),
              source: withKey(source, key),
              target,
              ...(label === undefined ? {} : { label }),
              createdAt: yield* DateTime.now
            }
            yield* store.putRelay(record)
            return toRelay(record, yield* start(record))
          }),

        list: Effect.gen(function* () {
          const records = yield* store.relays
          return yield* Effect.forEach(
            records,
            (record) =>
              Effect.map(
                ask(
                  record.id,
                  clients.use(record.id, (client) => client.Status())
                ),
                (status) => toRelay(record, status)
              ),
            { concurrency: 3 }
          )
        }),

        remove: (id) =>
          Effect.gen(function* () {
            yield* find(id)
            yield* store.deleteRelay(id)
            yield* stop(id)
          }),

        restart: (id) =>
          Effect.gen(function* () {
            const record = yield* find(id)
            // A RelayDO that lost its state (it forgot while the project was held) starts from scratch.
            const status = yield* clients
              .use(id, (client) => client.Restart())
              .pipe(
                Effect.catchTag("NotFound", () => start(record)),
                (effect) => ask(id, effect)
              )
            return toRelay(record, status)
          }),

        deliver: (id, deliveries) =>
          Effect.gen(function* () {
            if (yield* held) return yield* new NotFound({ entity: "relay", id })
            const record = yield* find(id)
            // A limit they set holds the project: its relays wait with everything else.
            const pause = yield* core.usagePause
            if (
              Option.isSome(pause) &&
              pause.value.limit !== undefined &&
              DateTime.toEpochMillis(pause.value.until) > (yield* Clock.currentTimeMillis)
            ) {
              return { delivered: 0, heldUntil: pause.value.until }
            }
            const project = yield* core.project.pipe(Effect.orDie)
            const port = record.target.port ?? project.publishedPort
            if (port === undefined) {
              return {
                delivered: 0,
                failure: {
                  message: "Nothing to deliver to: the app's port isn't published, and the relay has no --port."
                }
              }
            }
            return yield* sandbox.forwardRelay({ relayId: id, port, path: record.target.path, deliveries })
          }),

        credential: (id) =>
          Effect.gen(function* () {
            if (yield* held) return yield* new NotFound({ entity: "relay", id })
            const record = yield* find(id)
            // A Discord relay whose key was replaced by another (they connected a new one) uses the new one.
            const key = yield* resolveKey(record.source).pipe(
              Effect.catchTag("InvalidRequest", (error) =>
                record.source._tag === "Discord" && record.source.integrationId !== undefined
                  ? resolveKey(withoutKey(record.source)).pipe(
                      Effect.tap((replacement) =>
                        replacement === undefined
                          ? Effect.void
                          : store.putRelay({ ...record, source: withKey(record.source, replacement) })
                      )
                    )
                  : Effect.fail(error)
              )
            )
            if (key === undefined || key.access_json._tag !== "Key") {
              return yield* new InvalidRequest({ message: "This relay doesn't use a key." })
            }
            const value = yield* credentials.apiKey(key)
            const keyHash = yield* fingerprint(value.key)
            const current = yield* find(id)
            if (current.keyHash !== keyHash) yield* store.putRelay({ ...current, keyHash })
            return {
              key: Redacted.make(value.key),
              host: key.access_json.host,
              header: key.access_json.header,
              format: key.access_json.format
            }
          }),

        alert: (id, reason) =>
          Effect.gen(function* () {
            if (yield* held) return yield* new NotFound({ entity: "relay", id })
            yield* find(id)
            yield* projectLog.note("relay", "error", reason, { name: id })
            yield* core.enqueue(
              AgentEvent.cases.Alert.make({ id: yield* newEventId(), at: yield* DateTime.now, reason })
            )
          }),

        active: (id) =>
          Effect.gen(function* () {
            if (yield* held) return false
            return (yield* store.relays).some((relay) => relay.id === id)
          }),

        stopAll: Effect.flatMap(store.relays, (records) =>
          Effect.forEach(records, (record) => stop(record.id), { concurrency: 3, discard: true })
        ),

        startAll: Effect.flatMap(store.relays, (records) =>
          Effect.forEach(records, start, { concurrency: 3, discard: true })
        ),

        keysChanged: Effect.gen(function* () {
          if (yield* held) return
          const project = yield* core.project.pipe(Effect.orDie)
          const rows = yield* connections.integrations(project.ownerId)
          for (const record of yield* store.relays) {
            if (record.keyHash === undefined || record.source.integrationId === undefined) continue
            const row = rows.find((each) => each.id === record.source.integrationId)
            if (row === undefined || row.status !== "connected" || row.access_json._tag !== "Key") continue
            const keyHash = yield* fingerprint((yield* credentials.apiKey(row)).key)
            if (keyHash === record.keyHash) continue
            yield* clients
              .use(record.id, (client) => client.Restart())
              .pipe(
                Effect.catchTag("NotFound", () => start(record)),
                Effect.catchCause((cause) => Effect.logWarning("couldn't restart a relay", { relay: record.id, cause }))
              )
          }
        }),

        integrationChanged: (integration) =>
          Effect.gen(function* () {
            if (yield* held) return
            const discordKey = integration.access._tag === "Key" && isDiscordHost(integration.access.host)
            const records = (yield* store.relays).filter(
              (record) =>
                record.source.integrationId === integration.id || (discordKey && record.source._tag === "Discord")
            )
            yield* Effect.forEach(
              records,
              (record) =>
                clients
                  .use(record.id, (client) => client.Restart())
                  .pipe(
                    Effect.catchTag("NotFound", () => start(record)),
                    Effect.catchCause((cause) =>
                      Effect.logWarning("couldn't restart a relay", { relay: record.id, cause })
                    )
                  ),
              { concurrency: 3, discard: true }
            )
          })
      })
    })
  )
}
