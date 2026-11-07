/**
 * Deleting a project for good, from the Worker: its DO deletes everything it holds (`ProjectRpcs.Delete`), then
 * its media and attachments go from R2 and D1, and its app links leave Home. For `DeleteProject` and the operator's cleanup route.
 */
import type { ProjectId } from "@dream/domain"
import { Effect, Option } from "effect"
import { Attachments } from "../db/Attachments.ts"
import { Links } from "../db/Links.ts"
import { Projects } from "../db/Projects.ts"
import { MediaStore } from "../http/Media.ts"
import { ProjectClients } from "./Client.ts"

/** R2 deletes at most this many keys per call. */
const R2DeleteBatch = 1000

export const deleteProject = Effect.fn("deleteProject")(function* (projectId: ProjectId) {
  const clients = yield* ProjectClients
  const projects = yield* Projects
  const media = yield* MediaStore
  yield* clients.use(projectId, (client) => client.Delete())
  const attachments = yield* Attachments
  const keys = [...(yield* projects.mediaKeys(projectId)), ...(yield* attachments.keysForProject(projectId))]
  if (keys.length > 0 && Option.isSome(media.bucket)) {
    const bucket = media.bucket.value
    for (let start = 0; start < keys.length; start += R2DeleteBatch) {
      const batch = keys.slice(start, start + R2DeleteBatch)
      yield* Effect.tryPromise(() => bucket.delete(batch)).pipe(
        Effect.catch((error) => Effect.logWarning("couldn't delete a deleted project's media", String(error)))
      )
    }
  }
  yield* projects.removeMedia(projectId)
  yield* attachments.removeForProject(projectId)
  // Its links went to an app that's gone.
  yield* (yield* Links).deleteForProject(projectId)
})
