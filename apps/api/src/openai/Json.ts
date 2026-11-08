/**
 * JSON from apps and from OpenAI, decoded with Schema at the edge: text that isn't JSON, or isn't the shape asked
 * for, is `None`, never a throw.
 */
import { Option, Schema } from "effect"

/** A JSON object, kept whole (the gateway passes request bodies on with its changes). */
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
export type JsonObject = typeof JsonObject.Type

/** `text` parsed as JSON and decoded with `schema`. */
export const decodeJsonText = <S extends Schema.Codec<any, any, never, never>>(schema: S) => {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema))
  return (text: string): Option.Option<S["Type"]> => decode(text)
}

/** Anything already parsed, decoded with `schema`. */
export const decodeValue = <S extends Schema.Codec<any, any, never, never>>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema)
  return (value: unknown): Option.Option<S["Type"]> => decode(value)
}

/** `text` as any JSON value, for observers that decode it further. */
export const parseAny = decodeJsonText(Schema.Unknown)
