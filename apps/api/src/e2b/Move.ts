/**
 * Moves a project to a sandbox of another size. E2B can't resize a sandbox, so this makes a new one from the other
 * size's template and copies the old one's home directory into it: the project, `~/.dream` (dreamd's inbox, session
 * and state, the published port, the relay key), `~/.claude`, `~/.codex` and the harnesses' runs. The harness
 * bootstrap and caches stay behind (the template has the current harnesses; caches refill). Memory can't move, so
 * before packing, `move.mjs capture` notes the servers the agent left running, and after dreamd is up in the new
 * sandbox, `restore` starts them again from the same directories with the same environment.
 *
 * The copy goes sandbox to sandbox, as a refresh's does: the old one packs a tar, and the new one downloads it from
 * the old one's envd. The caller decides when (between turns), starts dreamd in the new sandbox, swaps its record
 * over and kills the old one; a failure here kills the new one and leaves the old one as it was.
 */
import { DaemonEnvFile, UpstreamFailure } from "@dream/domain"
import { Context, Data, Duration, Effect, Layer, Schema } from "effect"
import { E2B, type NetworkRules, type SandboxAccess } from "./E2B.ts"
import { Envd } from "./Envd.ts"

const Tarball = "/tmp/dream-move.tar"
const MoveScript = "/opt/dream/sandbox/move.mjs"

/**
 * Left out of the copy: the new sandbox's template has the current harnesses, and caches refill. dreamd's env file
 * too: the new dreamd starts when the caller writes its own (with a new daemon token), not halfway through the unpack.
 * And dreamd's own process log, which starts afresh in the new sandbox; the project's log beside it
 * (`<source>.jsonl`, `dream logs`) comes over.
 */
export const excluded = [
  "./.ai-sdk-harness/.harness-bootstrap",
  "./.cache",
  "./.npm/_cacache",
  "./.bun/install/cache",
  `./${DaemonEnvFile.replace("/home/user/", "")}`,
  // The new sandbox's dreamd already holds its log open (it waits for the env file from boot); replacing the file
  // under it would hide everything it writes. It writes nothing else there before its env file comes.
  "./.dream/logs/dreamd.log",
  "./.dream/logs/dreamd.log.1"
]

/** In the old sandbox, as root: pack the home directory beside it, failing early when the disk can't hold it. */
export const packCommand = [
  "set -euo pipefail",
  `rm -f ${Tarball}`,
  `need=$(du -sk ${excluded.map((path) => `--exclude=${path}`).join(" ")} /home/user | cut -f1)`,
  `free=$(df -k --output=avail /tmp | tail -1)`,
  `if [ "$need" -gt $(( free - 262144 )) ]; then echo "the home directory (\${need} KB) doesn't fit in the free disk (\${free} KB) to pack it" >&2; exit 3; fi`,
  `tar -C /home/user ${excluded.map((path) => `--exclude=${path}`).join(" ")} -cf ${Tarball} .`
].join("\n")

/** In the new sandbox, as root: download the old one's tar and unpack it over the home directory, owners kept. */
export const unpackCommand = [
  "set -euo pipefail",
  `curl -fsS --retry 3 -H "x-access-token: $FROM_TOKEN" "$FROM_URL" | tar -x -C /home/user --same-owner --same-permissions`
].join("\n")

const Restored = Schema.fromJsonString(
  Schema.Struct({ restarted: Schema.Array(Schema.String), notRestarted: Schema.Array(Schema.String) })
)
export type Restored = typeof Restored.Type

export class MoveFailed extends Data.TaggedError("MoveFailed")<{
  readonly step: string
  readonly message: string
}> {}

export interface MoveOptions {
  readonly from: SandboxAccess
  /** The template of the size it moves to. */
  readonly template: string
  readonly timeoutSeconds: number
  readonly metadata: Readonly<Record<string, string>>
  readonly rules: NetworkRules
}

export class SandboxMove extends Context.Service<
  SandboxMove,
  {
    /** Makes the new sandbox and copies the old one's home directory into it; dreamd isn't started yet. */
    readonly copy: (options: MoveOptions) => Effect.Effect<SandboxAccess, MoveFailed>
    /** Starts the servers `copy` noted, in the new sandbox (dreamd running), and says which came back. */
    readonly restore: (target: SandboxAccess) => Effect.Effect<Restored, MoveFailed>
  }
>()("@dream/api/SandboxMove") {
  static readonly layer = Layer.effect(
    SandboxMove,
    Effect.gen(function* () {
      const e2b = yield* E2B
      const envd = yield* Envd

      const run = (
        sandbox: SandboxAccess,
        step: string,
        command: string,
        options: {
          readonly user: "root" | "user"
          readonly timeout: Duration.Input
          readonly envs?: Record<string, string>
        }
      ) =>
        envd.run(sandbox, { command, ...options }).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.output)
              : Effect.fail(
                  new UpstreamFailure({
                    service: "sandbox",
                    message: result.output.trim().split("\n").slice(-3).join(" | ") || `exit ${result.exitCode}`
                  })
                )
          ),
          Effect.mapError((error) => new MoveFailed({ step, message: error.message }))
        )

      const copy = Effect.fn("SandboxMove.copy")(function* (options: MoveOptions) {
        const from = options.from
        yield* run(from, "capture", `node ${MoveScript} capture`, { user: "root", timeout: "1 minute" })
        yield* run(from, "pack", packCommand, { user: "root", timeout: "10 minutes" })
        const target = yield* e2b
          .create({
            template: options.template,
            timeoutSeconds: options.timeoutSeconds,
            autoPause: true,
            envVars: {},
            metadata: options.metadata,
            rules: options.rules
          })
          .pipe(Effect.mapError((error) => new MoveFailed({ step: "create", message: error.message })))
        yield* run(target, "copy", unpackCommand, {
          user: "root",
          timeout: "10 minutes",
          envs: {
            FROM_URL: `https://49983-${from.sandboxId}.${from.domain}/files?path=${encodeURIComponent(Tarball)}&username=root`,
            FROM_TOKEN: from.envdAccessToken
          }
        }).pipe(Effect.tapError(() => e2b.kill(target.sandboxId).pipe(Effect.ignore)))
        yield* run(from, "clean up", `rm -f ${Tarball}`, { user: "root", timeout: "1 minute" }).pipe(Effect.ignore)
        return target
      })

      const restore = Effect.fn("SandboxMove.restore")(function* (target: SandboxAccess) {
        const output = yield* run(target, "restore", `node ${MoveScript} restore`, {
          user: "user",
          timeout: "2 minutes"
        })
        const last = output.trim().split("\n").at(-1) ?? ""
        return yield* Schema.decodeUnknownEffect(Restored)(last).pipe(
          Effect.mapError(
            () => new MoveFailed({ step: "restore", message: `unexpected output: ${last.slice(0, 200)}` })
          )
        )
      })

      return SandboxMove.of({ copy, restore })
    })
  )
}
