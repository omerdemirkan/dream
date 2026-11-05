/**
 * Small helpers shared by the D1 repositories and the ProjectDO store.
 * Rows are decoded with Schema at this edge; database and decoding failures
 * are defects (the schema is ours, so a mismatch is a bug).
 */
import { DateTime, Effect, Schema } from "effect"
import type { SqlError } from "effect/sql/SqlError"

export const decodeRows =
  <S extends Schema.Codec<any, any, never, never>>(row: S) =>
  (rows: Effect.Effect<ReadonlyArray<unknown>, SqlError>): Effect.Effect<ReadonlyArray<S["Type"]>> =>
    rows.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(row))), Effect.orDie)

export const decodeFirst =
  <S extends Schema.Codec<any, any, never, never>>(row: S) =>
  (rows: Effect.Effect<ReadonlyArray<unknown>, SqlError>): Effect.Effect<S["Type"] | undefined> =>
    decodeRows(row)(rows).pipe(Effect.map((all) => all[0]))

/** Runs a statement for its effect. */
export const exec = <A>(statement: Effect.Effect<A, SqlError>): Effect.Effect<void> =>
  statement.pipe(Effect.asVoid, Effect.orDie)

/** A JSON column holding the JSON encoding of `schema`. */
export const JsonColumn = <S extends Schema.Top>(schema: S) => Schema.fromJsonString(Schema.toCodecJson(schema))

/** `JsonColumn` typed for the context-free domain schemas it's used with. */
export const jsonCodec = <S extends Schema.Top>(schema: S): Schema.Codec<S["Type"], string> =>
  JsonColumn(schema) as unknown as Schema.Codec<S["Type"], string>

export const encodeJson = <S extends Schema.Top>(schema: S, value: S["Type"]): string =>
  Schema.encodeSync(jsonCodec(schema))(value)

export const decodeJson = <S extends Schema.Top>(schema: S, json: string): S["Type"] =>
  Schema.decodeUnknownSync(jsonCodec(schema))(json)

/** ISO-8601 text column ↔ DateTime.Utc. */
export const IsoDate = Schema.DateTimeUtcFromString

export const iso = (at: DateTime.Utc): string => DateTime.formatIso(at)

export const nowIso: Effect.Effect<string> = Effect.map(DateTime.now, iso)

export const nullable = <S extends Schema.Top>(schema: S) => Schema.NullOr(schema)

/** `null` for an absent optional value, for SQL parameters. */
export const orNull = <A>(value: A | undefined): A | null => (value === undefined ? null : value)
