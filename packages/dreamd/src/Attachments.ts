/**
 * Their attachments, copied into the sandbox before the turn that reads the message, at `attachmentPath` (one folder
 * per message under `~/.dream/attachments`). dreamd fetches each from the Worker with the project token. A file
 * that's already there with the right size isn't fetched again, so a retried turn costs nothing. One that can't be
 * fetched is left out, and the turn prompt says so rather than naming a path that doesn't exist.
 */
import { type AgentEvent, type Attachment, type MediaId, Routes } from "@dream/domain"
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Redacted, Schedule } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { DreamdConfig } from "./Config.ts"

class AttachmentFetchError extends Data.TaggedError("AttachmentFetchError")<{ readonly message: string }> {}

/** Every attachment in these events, with the message it came with. */
export const attachmentsOf = (
  events: ReadonlyArray<AgentEvent>
): ReadonlyArray<{ readonly messageId: string; readonly attachment: Attachment }> =>
  events.flatMap((event) =>
    event._tag === "UserMessage"
      ? (event.attachments ?? []).map((attachment) => ({ messageId: event.messageId, attachment }))
      : []
  )

export class Attachments extends Context.Service<
  Attachments,
  {
    /** Copies the attachments of these events into the sandbox and returns the ones it couldn't. */
    readonly fetch: (events: ReadonlyArray<AgentEvent>) => Effect.Effect<ReadonlySet<MediaId>>
  }
>()("@dream/dreamd/Attachments") {
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const dir = path.join(config.home, ".dream", "attachments")

      const copy = (messageId: string, attachment: Attachment) =>
        Effect.gen(function* () {
          const target = path.join(dir, messageId, attachment.name)
          const existing = yield* fs.stat(target).pipe(Effect.option)
          if (Option.isSome(existing) && Number(existing.value.size) === attachment.sizeBytes) return
          const bytes = yield* HttpClientRequest.get(`${config.apiUrl}${Routes.sandboxAttachment(attachment.id)}`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(config.projectToken)),
            http.execute,
            Effect.flatMap((response) => response.arrayBuffer),
            Effect.timeout("2 minutes"),
            Effect.mapError((error) => new AttachmentFetchError({ message: error.message }))
          )
          if (bytes.byteLength !== attachment.sizeBytes) {
            return yield* new AttachmentFetchError({
              message: `got ${bytes.byteLength} bytes instead of ${attachment.sizeBytes}`
            })
          }
          const partial = `${target}.part`
          yield* fs.makeDirectory(path.dirname(target), { recursive: true })
          yield* fs.writeFile(partial, new Uint8Array(bytes))
          yield* fs.rename(partial, target)
        }).pipe(
          Effect.mapError((error) =>
            error._tag === "AttachmentFetchError" ? error : new AttachmentFetchError({ message: error.message })
          ),
          Effect.retry({ schedule: Schedule.exponential("1 second"), times: 2 })
        )

      return Attachments.of({
        fetch: (events) =>
          Effect.gen(function* () {
            const missing = new Set<MediaId>()
            yield* Effect.forEach(
              attachmentsOf(events),
              ({ messageId, attachment }) =>
                copy(messageId, attachment).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Couldn't copy an attachment into the sandbox", {
                      attachment: attachment.id,
                      error: error.message
                    }).pipe(Effect.andThen(Effect.sync(() => missing.add(attachment.id))))
                  )
                ),
              { concurrency: 3, discard: true }
            )
            return missing
          })
      })
    })
  )

  /** For tests that send no attachments. */
  static readonly layerNone = Layer.succeed(Attachments, Attachments.of({ fetch: () => Effect.succeed(new Set()) }))
}
