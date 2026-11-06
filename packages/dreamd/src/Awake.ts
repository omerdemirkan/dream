/**
 * Keeping the sandbox awake between turns. E2B pauses a sandbox five minutes
 * after it woke, whatever runs in it: requests, CPU and open connections don't
 * count. So while dreamd has work the agent isn't doing in a turn, it asks the
 * API (`StayAwake`, about once a minute) to keep the sandbox up five more
 * minutes:
 *
 * - while a scheduled `--run` command runs (`Commands`), and
 * - while the published app is in use. Each request through E2B's proxy leaves
 *   the app's port a TIME_WAIT entry in the kernel's TCP table for a minute,
 *   and an open WebSocket (or a request still being answered) shows as
 *   ESTABLISHED. The proxy keeps no idle connections, so both mean real use.
 *   Connections from inside the sandbox (on loopback) don't count, so a
 *   process polling its own app can't keep the sandbox up; a scheduled
 *   command calling the app counts as the command.
 *   A connection that stays open with nothing new arriving stops counting
 *   after `QuietConnectionLimit`, so a tab left open can't hold the sandbox up
 *   forever.
 *
 * During a turn the ProjectDO's keepalive already holds a longer timeout, and
 * the API leaves that alone. A Worker older than `StayAwake` refuses it: that's
 * logged once, and dreamd carries on as before.
 */
import { Clock, Context, Duration, Effect, FileSystem, Layer, Option, Ref, Schedule } from "effect"
import { Api } from "./Api.ts"
import { Commands } from "./Commands.ts"
import { Published } from "./Published.ts"

/** How often dreamd looks. More often than `TIME_WAIT` lasts (60 s), so no request goes unseen. */
export const CheckEvery = Duration.seconds(30)
/** At most one `StayAwake` this often. */
export const SendEvery = Duration.minutes(1)
/** An open connection with no new request counts this long. */
export const QuietConnectionLimit = Duration.hours(2)

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

/** Whether the app is in use now, and what to remember for the next look. */
export const appInUse = (
  previous: UseState,
  traffic: PortTraffic,
  nowMs: number
): { readonly inUse: boolean; readonly state: UseState } => {
  const fresh = traffic.recentlyClosed > 0 || [...traffic.open].some((remote) => !previous.open.has(remote))
  const lastRequestMs = fresh ? nowMs : previous.lastRequestMs
  const quietFor = lastRequestMs === undefined ? Number.POSITIVE_INFINITY : nowMs - lastRequestMs
  const inUse =
    traffic.recentlyClosed > 0 || (traffic.open.size > 0 && quietFor < Duration.toMillis(QuietConnectionLimit))
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
    /** Look every `CheckEvery`, and ask to stay awake while there's work, forever. */
    readonly run: Effect.Effect<never>
  }
>()("@dream/dreamd/Awake") {
  static readonly layer = Layer.effect(
    Awake,
    Effect.gen(function* () {
      const api = yield* Api
      const commands = yield* Commands
      const published = yield* Published
      const traffic = yield* AppTraffic
      const use = yield* Ref.make(noUse)
      /** Work seen since the last `StayAwake`. */
      const pending = yield* Ref.make(Option.none<"command" | "app">())
      const lastSentMs = yield* Ref.make<number | undefined>(undefined)
      const failing = yield* Ref.make(false)

      const look = Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        const port = yield* published.port
        let app = false
        if (Option.isSome(port)) {
          const seen = appInUse(yield* Ref.get(use), yield* traffic.read(port.value), nowMs)
          yield* Ref.set(use, seen.state)
          app = seen.inUse
        }
        const reason = (yield* commands.busy) ? "command" : app ? "app" : undefined
        if (reason !== undefined) {
          // A command outranks the app, for the API's log.
          yield* Ref.update(pending, (current) =>
            reason === "app" && Option.isSome(current) ? current : Option.some(reason)
          )
        }
        const due = yield* Ref.get(pending)
        const last = yield* Ref.get(lastSentMs)
        if (Option.isNone(due) || (last !== undefined && nowMs - last < Duration.toMillis(SendEvery))) return
        yield* Ref.set(pending, Option.none())
        yield* Ref.set(lastSentMs, nowMs)
        yield* api.stayAwake(due.value).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Ref.getAndSet(failing, true).pipe(
                Effect.flatMap((already) =>
                  already
                    ? Effect.void
                    : Effect.logWarning("Couldn't ask to keep the sandbox awake; carrying on without it", {
                        error: error.message
                      })
                )
              ),
            onSuccess: () =>
              Ref.getAndSet(failing, false).pipe(
                Effect.flatMap((was) =>
                  was ? Effect.logInfo("Asking to keep the sandbox awake works again") : Effect.void
                )
              )
          })
        )
      })

      return Awake.of({
        run: look.pipe(
          Effect.catchCause((cause) => Effect.logWarning("Couldn't check whether the sandbox has work", cause)),
          Effect.repeat(Schedule.spaced(CheckEvery)),
          Effect.andThen(Effect.never)
        )
      })
    })
  )
}
