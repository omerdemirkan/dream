/**
 * Uploading a photo or file they picked: `CreateAttachmentUpload`, then the bytes go where it says
 * (`FileTransfer`). The composer uploads each as soon as it's picked, so sending only names the ids.
 */
import { type Attachment, AttachmentLimits, type MediaUploadTarget } from "@dream/domain"
import { Context, Data, Duration, Effect, Layer } from "effect"
import { AppClient } from "./AppClient.ts"
import type { PickedFile } from "./attachments.ts"
import { describeError } from "./errors.ts"

export class AttachmentError extends Data.TaggedError("AttachmentError")<{ readonly message: string }> {}

/** Sends a local file's bytes as an upload target says. The platform supplies it; tests and fixtures fake it. */
export class FileTransfer extends Context.Service<
  FileTransfer,
  { readonly put: (uri: string, target: MediaUploadTarget) => Effect.Effect<void, AttachmentError> }
>()("@dream/mobile/FileTransfer") {
  /** Fixtures: nothing leaves the phone, after a moment that shows the upload. */
  static readonly layerFake = Layer.succeed(
    FileTransfer,
    FileTransfer.of({ put: () => Effect.sleep(Duration.millis(700)) })
  )

  /** Where the platform can't upload (a build without it): every upload fails with a sentence. */
  static readonly layerUnavailable = Layer.succeed(
    FileTransfer,
    FileTransfer.of({
      put: () => Effect.fail(new AttachmentError({ message: "This version of Dream can't send files yet." }))
    })
  )
}

/** How long one upload may take: 25 MB on a slow connection. */
const uploadTimeout = Duration.minutes(3)

export class AttachmentUploads extends Context.Service<
  AttachmentUploads,
  { readonly upload: (file: PickedFile) => Effect.Effect<Attachment, AttachmentError> }
>()("@dream/mobile/AttachmentUploads") {
  static readonly layer = Layer.effect(
    AttachmentUploads,
    Effect.gen(function* () {
      const app = yield* AppClient
      const transfer = yield* FileTransfer
      return AttachmentUploads.of({
        upload: Effect.fn("AttachmentUploads.upload")(function* (file: PickedFile) {
          if (file.sizeBytes > AttachmentLimits.maxBytes) {
            return yield* new AttachmentError({ message: `${file.name} is too large to send.` })
          }
          const { attachment, upload } = yield* app
            .CreateAttachmentUpload({
              name: file.name,
              contentType: file.contentType,
              sizeBytes: file.sizeBytes,
              ...(file.width === undefined ? {} : { width: file.width }),
              ...(file.height === undefined ? {} : { height: file.height })
            })
            .pipe(Effect.mapError((error) => new AttachmentError({ message: describeError(error) })))
          yield* transfer.put(file.uri, upload).pipe(
            Effect.timeoutOrElse({
              duration: uploadTimeout,
              orElse: () => Effect.fail(new AttachmentError({ message: `${file.name} took too long to upload.` }))
            })
          )
          return attachment
        })
      })
    })
  )
}
