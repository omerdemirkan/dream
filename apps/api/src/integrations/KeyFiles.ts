/**
 * A project's file keys (`IntegrationAccess.File`): the keys that can't travel
 * in a header, which the person agreed to put in that project's sandbox as
 * files. The ProjectDO writes them there; the Worker uses them to refuse
 * `dream` calls that would show one to the person.
 */
import { InvalidRequest, type ProjectId, type UserId } from "@dream/domain"
import { Context, Effect, Layer } from "effect"
import { Connections, type IntegrationRow } from "../db/Connections.ts"
import { CredentialStore } from "./CredentialStore.ts"

export interface KeyFile {
  readonly row: IntegrationRow
  readonly service: string
  /** The file's name in `SandboxKeyDir`. */
  readonly name: string
  readonly path: string
  readonly value: string
}

/** Shorter values could turn up in ordinary text by chance; no real key is this short. */
const MinCheckedLength = 6

/** The file key that `payload` would reveal, if any. Compared as JSON, so escaping doesn't hide a match. */
export const leakedKey = (payload: unknown, keys: ReadonlyArray<KeyFile>): KeyFile | undefined => {
  const text = JSON.stringify(payload) ?? ""
  return keys.find(
    (key) => key.value.length >= MinCheckedLength && text.includes(JSON.stringify(key.value).slice(1, -1))
  )
}

export class KeyFiles extends Context.Service<
  KeyFiles,
  {
    /** The connected file keys of one project, decrypted. */
    readonly forProject: (userId: UserId, projectId: ProjectId) => Effect.Effect<ReadonlyArray<KeyFile>>
    /** Fails if `payload` contains one of the project's file keys. */
    readonly refuseLeak: (userId: UserId, projectId: ProjectId, payload: unknown) => Effect.Effect<void, InvalidRequest>
  }
>()("@dream/api/KeyFiles") {
  static readonly layer = Layer.effect(
    KeyFiles,
    Effect.gen(function* () {
      const connections = yield* Connections
      const store = yield* CredentialStore

      const forProject = Effect.fn("KeyFiles.forProject")(function* (userId: UserId, projectId: ProjectId) {
        const files = (yield* connections.integrations(userId)).flatMap((row) =>
          row.status === "connected" && row.access_json._tag === "File" && row.access_json.projectId === projectId
            ? [{ row, access: row.access_json }]
            : []
        )
        return yield* Effect.forEach(files, ({ row, access }) =>
          Effect.map(
            store.apiKey(row),
            (credential): KeyFile => ({
              row,
              service: access.service,
              name: access.name,
              path: access.path,
              value: credential.key
            })
          )
        )
      })

      const refuseLeak = Effect.fn("KeyFiles.refuseLeak")(function* (
        userId: UserId,
        projectId: ProjectId,
        payload: unknown
      ) {
        const leaked = leakedKey(payload, yield* forProject(userId, projectId))
        if (leaked === undefined) return
        return yield* new InvalidRequest({
          message:
            `This contains their ${leaked.service} key from ${leaked.path}, so Dream didn't send it. ` +
            "Nothing that reaches them may include a key; leave it out and send the rest."
        })
      })

      return KeyFiles.of({ forProject, refuseLeak })
    })
  )
}
