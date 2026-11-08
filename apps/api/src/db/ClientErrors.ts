/**
 * Crash and error reports from the iPhone app (D1 `client_errors`), written by POST /client-errors and read by
 * operators at GET /admin/client-errors. A report is the error and where it happened (`ClientErrorReport`), never
 * what the person wrote; `userId` only says whose app it was, when the report came with a session.
 */
import { ClientErrorKind, type ClientErrorReport, UserId } from "@dream/domain"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { randomToken } from "../lib/Ids.ts"
import { decodeRows, exec, IsoDate, nullable, orNull } from "./Sql.ts"

const ClientErrorRow = Schema.Struct({
  id: Schema.String,
  received_at: IsoDate,
  occurred_at: IsoDate,
  kind: ClientErrorKind,
  message: Schema.String,
  stack: nullable(Schema.String),
  component_stack: nullable(Schema.String),
  screen: nullable(Schema.String),
  app_version: Schema.String,
  app_build: Schema.String,
  update_id: nullable(Schema.String),
  runtime_version: nullable(Schema.String),
  channel: nullable(Schema.String),
  os: nullable(Schema.String),
  user_id: nullable(UserId)
})
export type ClientErrorRow = typeof ClientErrorRow.Type

export class ClientErrors extends Context.Service<
  ClientErrors,
  {
    readonly record: (reports: ReadonlyArray<ClientErrorReport>, userId: UserId | undefined) => Effect.Effect<void>
    /** The latest reports, newest first. */
    readonly latest: (options: {
      readonly limit: number
      readonly kind?: ClientErrorKind | undefined
    }) => Effect.Effect<ReadonlyArray<ClientErrorRow>>
  }
>()("@dream/api/ClientErrors") {
  static readonly layer = Layer.effect(
    ClientErrors,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const record = Effect.fn("ClientErrors.record")(function* (
        reports: ReadonlyArray<ClientErrorReport>,
        userId: UserId | undefined
      ) {
        const received = DateTime.formatIso(yield* DateTime.now)
        for (const r of reports)
          yield* exec(sql`
            INSERT INTO client_errors (id, received_at, occurred_at, kind, message, stack, component_stack, screen,
              app_version, app_build, update_id, runtime_version, channel, os, user_id)
            VALUES (${`err_${randomToken(22)}`}, ${received}, ${DateTime.formatIso(r.occurredAt)}, ${r.kind},
              ${r.message}, ${orNull(r.stack)}, ${orNull(r.componentStack)}, ${orNull(r.screen)}, ${r.build.version},
              ${r.build.build}, ${orNull(r.build.updateId)}, ${orNull(r.build.runtimeVersion)},
              ${orNull(r.build.channel)}, ${orNull(r.build.os)}, ${orNull(userId)})`)
      })

      const latest = Effect.fn("ClientErrors.latest")(function* (options: {
        readonly limit: number
        readonly kind?: ClientErrorKind | undefined
      }) {
        return yield* (
          options.kind === undefined
            ? sql`SELECT * FROM client_errors ORDER BY received_at DESC LIMIT ${options.limit}`
            : sql`SELECT * FROM client_errors WHERE kind = ${options.kind} ORDER BY received_at DESC LIMIT ${options.limit}`
        ).pipe(decodeRows(ClientErrorRow))
      })

      return ClientErrors.of({ record, latest })
    })
  )
}
