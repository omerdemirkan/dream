/**
 * Keeping the sandbox awake between turns, and letting it go back to sleep. E2B pauses a sandbox when its timeout
 * runs out, whatever runs in it: requests, CPU and open connections don't count. A wake buys five minutes, and a
 * turn's end a minute and a half. So while dreamd has work the agent isn't doing in a turn, it asks the API
 * (`StayAwake`, about once a minute) to keep the sandbox up a couple of minutes more:
 *
 * - while a scheduled `--run` command runs (`Commands`),
 * - while the app is taking a relay's delivery (`RelayForwarder`), and
 * - while the published app is in use. Each request through E2B's proxy leaves
 *   the app's port a TIME_WAIT entry in the kernel's TCP table for a minute,
 *   and an open WebSocket (or a request still being answered) shows as
 *   ESTABLISHED. The proxy keeps no idle connections, so both mean real use.
 *   Connections from inside the sandbox (on loopback) don't count, so a
 *   process polling its own app can't keep the sandbox up; a scheduled
 *   command calling the app counts as the command, and a relay delivery as
 *   the delivery.
 *   A connection that stays open with nothing new arriving stops counting
 *   after `QuietConnectionLimit`, so a tab left open can't hold the sandbox up
 *   for long. dreamd's own look at the published URL after a turn
 *   (`Published.selfCheck`) reaches the app the same way, so the traffic it
 *   makes doesn't count.
 *
 * The other way round: when the sandbox woke to run a scheduled command, take a relay delivery or serve a visit to
 * the app, it shouldn't then sit idle for the rest of its timeout. Once that work is done (`SleepAfter` after a
 * command or delivery; for the app, once its requests have stopped counting and `AfterAppUse` more has passed) and
 * nothing else is going on (no turn running or waiting, no command pending, no turn ended in the last `AfterTurn`),
 * dreamd asks the API to put it to sleep now (`Sleep`). If only time stands in the way, it waits and asks then. The
 * API checks its own side too (a turn starting, events on their way, a refresh) before it pauses the sandbox.
 * Anything that would have woken the sandbox still does, in under a second.
 *
 * During a turn the ProjectDO's keepalive already holds a longer timeout, and
 * the API leaves that alone. A Worker older than `StayAwake` or `Sleep` refuses
 * it: that's logged once, and dreamd carries on as before.
 */
import { Clock, Context, DateTime, Duration, Effect, FileSystem, Layer, Option, Ref, Stream } from "effect"
import { Agent } from "./Agent.ts"
import { Api, type ApiError, type AwakeReason, type SleepReason } from "./Api.ts"
import { Commands } from "./Commands.ts"
import { Published } from "./Published.ts"
import { RelayForwarder } from "./Relays.ts"

/** How often dreamd looks. More often than `TIME_WAIT` lasts (60 s), so no request goes unseen. */
export const CheckEvery = Duration.seconds(30)
/** At most one `StayAwake` this often. */
export const SendEvery = Duration.minutes(1)
/** An open connection with no new request counts this long. */
export const QuietConnectionLimit = Duration.minutes(20)
/** How long dreamd waits after a command or relay delivery finishes before asking to sleep, for more to arrive. */
export const SleepAfter = Duration.seconds(5)
/**
 * After the app's requests stop counting, dreamd waits this much longer before asking to sleep. A closed request
 * counts for a minute already (the kernel keeps it in `TIME_WAIT`), so a visit ends about 1.5 minutes after its last
 * request.
 */
export const AfterAppUse = Duration.seconds(30)
/** A turn ended this recently: the API keeps the sandbox up for a minute and a half after a turn anyway. */
export const AfterTurn = Duration.seconds(100)
/** Connections closed by dreamd's own look at the published URL stay in the kernel's table this long after it. */
export const SelfCheckEcho = Duration.seconds(65)

/** What dreamd knows when it considers asking to sleep. */
export interface SleepCheck {
  readonly commandRunning: boolean
  /** Scheduled commands delivered but not started yet. */
  readonly commandsPending: number
  readonly relayDelivering: boolean
  readonly turnRunning: boolean
  /** Events waiting for a turn. */
  readonly queued: number
  readonly appInUse: boolean
  readonly lastAppUseMs: number | undefined
  readonly lastTurnEndedMs: number | undefined
  readonly nowMs: number
}

/**
 * Whether to ask to sleep: `now`; `wait` when only a recent app visit or turn stands in the way, so ask once that's
 * passed; `drop` when there's work (a turn, a command, a delivery, someone using the app), which keeps the sandbox up
 * and asks again when it's done.
 */
export const sleepVerdict = (check: SleepCheck): "now" | "wait" | "drop" => {
  const within = (ms: number | undefined, span: Duration.Duration) =>
    ms !== undefined && check.nowMs - ms < Duration.toMillis(span)
  const busy =
    check.commandRunning ||
    check.commandsPending > 0 ||
    check.relayDelivering ||
    check.turnRunning ||
    check.queued > 0 ||
    check.appInUse
  if (busy) return "drop"
  if (within(check.lastAppUseMs, AfterAppUse) || within(check.lastTurnEndedMs, AfterTurn)) return "wait"
  return "now"
}

/** Whether nothing in the sandbox needs it awake any more. */
export const nothingLeft = (check: SleepCheck): boolean => sleepVerdict(check) === "now"

/** The published port's inbound connections: those still open, and how many closed in the last minute. */
export interface PortTraffic {
  /** Open connections, by remote address and port. */
  readonly open: ReadonlySet<string>
  readonly recentlyClosed: number
}

const established = "01"
const timeWait = "06"

/** 127.0.0.0/8, ::1 and ::ffff:127.0.0.0/104, as the kernel's tables write them (hex, each word little-endian). */
const loopback = (host: string) =>
  host.length === 8
    ? host.endsWith("7F")
    : host === "00000000000000000000000001000000" ||
      (host.startsWith("0000000000000000FFFF0000") && host.endsWith("7F"))

/** The connections to `port` from outside the sandbox, in `/proc/net/tcp` or `/proc/net/tcp6` tables. */
export const portTraffic = (tables: ReadonlyArray<string>, port: number): PortTraffic => {
  const open = new Set<string>()
  let recentlyClosed = 0
  for (const table of tables) {
    for (const line of table.split("\n").slice(1)) {
      // sl local_address rem_address st …, addresses as hex `address:port`.
      const [, local, remote, state] = line.trim().split(/\s+/)
      if (local === undefined || remote === undefined) continue
      if (Number.parseInt(local.split(":")[1] ?? "", 16) !== port) continue
      if (loopback(remote.split(":")[0] ?? "")) continue
      if (state === established) open.add(remote)
      else if (state === timeWait) recentlyClosed++
    }
  }
  return { open, recentlyClosed }
}

/** What the last look saw, to tell new requests from connections that just stay open. */
export interface UseState {
  readonly open: ReadonlySet<string>
  /** When the last new request was seen, in epoch milliseconds. */
  readonly lastRequestMs: number | undefined
}

export const noUse: UseState = { open: new Set(), lastRequestMs: undefined }

/**
 * Whether the app is in use now, and what to remember for the next look. With `ignoreNew` (dreamd's own look at the
 * app is running or just ran), new connections and recently closed ones don't count; connections that were already
 * open at the last look still do.
 */
export const appInUse = (
  previous: UseState,
  traffic: PortTraffic,
  nowMs: number,
  ignoreNew = false
): { readonly inUse: boolean; readonly state: UseState } => {
  const open = ignoreNew ? new Set([...traffic.open].filter((remote) => previous.open.has(remote))) : traffic.open
  const closed = ignoreNew ? 0 : traffic.recentlyClosed
  const fresh = closed > 0 || [...open].some((remote) => !previous.open.has(remote))
  const lastRequestMs = fresh ? nowMs : previous.lastRequestMs
  const quietFor = lastRequestMs === undefined ? Number.POSITIVE_INFINITY : nowMs - lastRequestMs
  const inUse = closed > 0 || (open.size > 0 && quietFor < Duration.toMillis(QuietConnectionLimit))
  return { inUse, state: { open: traffic.open, lastRequestMs } }
}

/** The kernel's view of a port's TCP connections. */
export class AppTraffic extends Context.Service<
  AppTraffic,
  { readonly read: (port: number) => Effect.Effect<PortTraffic> }
>()("@dream/dreamd/AppTraffic") {
  static readonly layer = Layer.effect(
    AppTraffic,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const table = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))
      return AppTraffic.of({
        read: (port) =>
          Effect.map(Effect.all([table("/proc/net/tcp"), table("/proc/net/tcp6")]), (tables) =>
            portTraffic(tables, port)
          )
      })
    })
  )

  /** Whatever `traffic` holds at each look. */
  static readonly layerTest = (traffic: Ref.Ref<PortTraffic>) =>
    Layer.succeed(AppTraffic, AppTraffic.of({ read: () => Ref.get(traffic) }))

  /** Nobody uses the app. */
  static readonly layerNone = Layer.succeed(
    AppTraffic,
    AppTraffic.of({ read: () => Effect.succeed({ open: new Set<string>(), recentlyClosed: 0 }) })
  )
}

export class Awake extends Context.Service<
  Awake,
  {
    /** Look every `CheckEvery`, and when work finishes; ask to stay awake while there's work, and to sleep after. */
    readonly run: Effect.Effect<never>
  }
>()("@dream/dreamd/Awake") {
  static readonly layer = Layer.effect(
    Awake,
    Effect.gen(function* () {
      const api = yield* Api
      const agent = yield* Agent
      const commands = yield* Commands
      const relays = yield* RelayForwarder
      const published = yield* Published
      const traffic = yield* AppTraffic
      const use = yield* Ref.make(noUse)
      /** Work seen since the last `StayAwake`. */
      const pending = yield* Ref.make(Option.none<AwakeReason>())
      const lastSentMs = yield* Ref.make<number | undefined>(undefined)
      /** Work that finished since the sandbox last asked to sleep: what it would say it woke for. */
      const finished = yield* Ref.make(Option.none<SleepReason>())
      const failing = yield* Ref.make(false)
      const sleepFailing = yield* Ref.make(false)
      /** Whether the app was in use at the last look, to see a visit end. */
      const wasInUse = yield* Ref.make(false)
      /** The last turn end seen, to see a new one. */
      const turnSeen = yield* Ref.make(Option.none<number>())

      /** Logs the first failure of a run of them, and the recovery. */
      const reported = (flag: Ref.Ref<boolean>, what: string) => (effect: Effect.Effect<void, ApiError>) =>
        effect.pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Ref.getAndSet(flag, true).pipe(
                Effect.flatMap((already) =>
                  already
                    ? Effect.void
                    : Effect.logWarning(`Couldn't ask to ${what}; carrying on without it`, { error: error.message })
                )
              ),
            onSuccess: () =>
              Ref.getAndSet(flag, false).pipe(
                Effect.flatMap((was) => (was ? Effect.logInfo(`Asking to ${what} works again`) : Effect.void))
              )
          })
        )

      /** Notes work that finished, for the next ask to sleep. A command outranks a delivery, which outranks a visit. */
      const noteFinished = (reason: SleepReason) =>
        Ref.update(finished, (current) =>
          Option.isSome(current) && sleepRank(current.value) >= sleepRank(reason) ? current : Option.some(reason)
        )

      const look = Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        // A turn just ended: during it the API ignored StayAwake, so the next one goes out now if there's work.
        const turnEnded = yield* agent.lastTurnEnded
        if (Option.isSome(turnEnded) && !Option.contains(yield* Ref.get(turnSeen), turnEnded.value)) {
          yield* Ref.set(turnSeen, turnEnded)
          yield* Ref.set(lastSentMs, undefined)
        }
        const port = yield* published.port
        let app = false
        if (Option.isSome(port)) {
          const self = yield* published.selfCheck
          const ignoreNew =
            self.running || (self.endedMs !== undefined && nowMs - self.endedMs < Duration.toMillis(SelfCheckEcho))
          const seen = appInUse(yield* Ref.get(use), yield* traffic.read(port.value), nowMs, ignoreNew)
          yield* Ref.set(use, seen.state)
          app = seen.inUse
          if ((yield* Ref.getAndSet(wasInUse, app)) && !app) yield* noteFinished("app")
        }
        const commandRunning = yield* commands.busy
        const relayDelivering = yield* relays.busy
        // A command outranks a delivery, which outranks the app, for the API's log.
        const reason: AwakeReason | undefined = commandRunning
          ? "command"
          : relayDelivering
            ? "relay"
            : app
              ? "app"
              : undefined

        if (reason === undefined) {
          const woke = yield* Ref.get(finished)
          if (Option.isSome(woke)) {
            const status = yield* agent.status
            const check: SleepCheck = {
              commandRunning,
              commandsPending: yield* commands.pending,
              relayDelivering,
              turnRunning: status.turn === "running",
              queued: status.queued,
              appInUse: app,
              lastAppUseMs: (yield* Ref.get(use)).lastRequestMs,
              lastTurnEndedMs: Option.getOrUndefined(yield* agent.lastTurnEnded),
              nowMs
            }
            // One ask per stretch of work: if the API says no, the sandbox sleeps on its timeout. Only time standing
            // in the way (a visit or turn that just ended) keeps the ask for a later look.
            const verdict = sleepVerdict(check)
            if (verdict !== "wait") yield* Ref.set(finished, Option.none())
            if (verdict === "now") {
              yield* Ref.set(pending, Option.none())
              yield* Effect.logInfo("Nothing left to do; asking to sleep", { woke: woke.value })
              return yield* api
                .sleep(woke.value, DateTime.makeUnsafe(nowMs))
                .pipe(reported(sleepFailing, "put the sandbox to sleep"))
            }
          }
        } else {
          yield* Ref.update(pending, (current) =>
            Option.isSome(current) && rank(current.value) >= rank(reason) ? current : Option.some(reason)
          )
        }
        const due = yield* Ref.get(pending)
        const last = yield* Ref.get(lastSentMs)
        if (Option.isNone(due) || (last !== undefined && nowMs - last < Duration.toMillis(SendEvery))) return
        yield* Ref.set(pending, Option.none())
        yield* Ref.set(lastSentMs, nowMs)
        yield* api.stayAwake(due.value).pipe(reported(failing, "keep the sandbox awake"))
      })

      const workDone = Stream.merge(
        commands.finished.pipe(Stream.map((): SleepReason => "command")),
        relays.finished.pipe(Stream.map((): SleepReason => "relay"))
      ).pipe(Stream.tap(noteFinished), Stream.debounce(SleepAfter))

      return Awake.of({
        run: Stream.merge(Stream.tick(CheckEvery), workDone).pipe(
          Stream.runForEach(() =>
            look.pipe(
              Effect.catchCause((cause) => Effect.logWarning("Couldn't check whether the sandbox has work", cause))
            )
          ),
          Effect.andThen(Effect.never)
        )
      })
    })
  )
}

const rank = (reason: AwakeReason): number => (reason === "command" ? 3 : reason === "relay" ? 2 : 1)
const sleepRank = (reason: SleepReason): number => (reason === "command" ? 3 : reason === "relay" ? 2 : 1)
