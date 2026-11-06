/**
 * Kills throwaway sandboxes someone forgot: a script's check or probe left running or paused, or a refresh donor that
 * outlived its refresh. E2B bills a running sandbox by the second whatever it's doing, and nothing else would ever
 * stop one. The rule is `reapable` in `@dream/domain`: no owner (or a donor), started over an hour ago. A project's
 * sandbox is never touched, by its metadata or by the projects table. Runs with the Worker's maintenance.
 */
import { reapable, SandboxMetadataKey } from "@dream/domain"
import { Context, DateTime, Effect, Layer } from "effect"
import { Projects } from "../db/Projects.ts"
import { E2B } from "./E2B.ts"

export class SandboxReaper extends Context.Service<
  SandboxReaper,
  {
    /** Kill what's forgotten; the ids it killed. Never fails: a problem is logged and the next run tries again. */
    readonly sweep: Effect.Effect<ReadonlyArray<string>>
  }
>()("@dream/api/SandboxReaper") {
  static readonly layer = Layer.effect(
    SandboxReaper,
    Effect.gen(function* () {
      const e2b = yield* E2B
      const projects = yield* Projects
      const sweep = Effect.gen(function* () {
        const listed = yield* e2b.list
        const own = yield* projects.sandboxIds
        const now = yield* DateTime.now
        const killed: Array<string> = []
        for (const sandbox of listed.filter((s) => reapable(s, now, own))) {
          yield* e2b.kill(sandbox.sandboxId).pipe(
            Effect.tap(() =>
              Effect.logInfo("killed a forgotten sandbox", {
                sandboxId: sandbox.sandboxId,
                purpose: sandbox.metadata[SandboxMetadataKey.purpose] ?? "unlabeled",
                script: sandbox.metadata[SandboxMetadataKey.script],
                startedAt: DateTime.formatIso(sandbox.startedAt)
              })
            ),
            Effect.andThen(Effect.sync(() => killed.push(sandbox.sandboxId))),
            Effect.catch((error) =>
              Effect.logWarning("couldn't kill a forgotten sandbox", {
                sandboxId: sandbox.sandboxId,
                error: error.message
              })
            )
          )
        }
        return killed
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("couldn't look for forgotten sandboxes", error.message).pipe(Effect.as([]))
        ),
        Effect.withSpan("SandboxReaper.sweep")
      )
      return SandboxReaper.of({ sweep })
    })
  )
}
