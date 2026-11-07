/**
 * The phone decodes what Dream sends leniently, in this one place. A phone can be a build behind the API, so
 * the API may send a kind of message, access request, access state or project event that this build has never
 * heard of, and one of those must never take down a Snapshot, Chat history, Home, the needs-you deck or
 * Settings. The domain's unions are strict, so these schemas sit between them and the wire:
 *
 * - A message the app can't decode becomes a neutral row in Chat (`unsupportedMessage`), in its place.
 * - A project event the app can't decode is skipped (`null`, filtered out by `LiveProjects`).
 * - An open ask, project or integration the app can't decode is left out of its list.
 * - An agent activity the app can't decode (a state it doesn't know) is left off its snapshot or Home row, which
 *   then reads as from an API that sends none.
 *
 * `PhoneAppRpcs` and `PhoneProjectLiveRpcs` are the domain's groups with these success schemas; the app's real
 * clients use them. What they decode has the domain's types, so nothing else in the app changes.
 */
import {
  AppNotification,
  AppRpcs,
  AppSender,
  Integration,
  Message,
  MessageId,
  OpenAsk,
  ProjectEvent,
  ProjectId,
  ProjectSummary,
  TextMessage
} from "@dream/domain"
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

type JsonCodec<A> = Schema.Codec<A, unknown, never, never>

const decodeJson = <A>(schema: JsonCodec<A>) => Schema.decodeUnknownOption(Schema.toCodecJson(schema))
const encodeJson = <A>(schema: JsonCodec<A>) => Schema.encodeSync(Schema.toCodecJson(schema))

/** Any JSON in, `schema`'s type out by `decode` (which can refuse); encodes as `schema` does. */
const lenient = <A>(schema: JsonCodec<A>, decode: (raw: unknown) => Option.Option<A>) =>
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.toType(schema), {
      decode: SchemaGetter.transformEffect((raw: unknown, options) =>
        Option.match(decode(raw), {
          onNone: () => Effect.fail(new SchemaIssue.InvalidValue(undefined, raw, options)),
          onSome: Effect.succeed
        })
      ),
      encode: SchemaGetter.transform(encodeJson(schema))
    })
  )

/** An array of `item`s, leaving out the elements that don't decode. */
export const lenientArray = <A>(item: JsonCodec<A>) =>
  Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(Schema.toType(Schema.Array(item)), {
      decode: SchemaGetter.transform((raws: ReadonlyArray<unknown>) =>
        raws.flatMap((raw) => Option.toArray(decodeJson(item)(raw)))
      ),
      encode: SchemaGetter.transform((items: ReadonlyArray<A>) => items.map((value) => encodeJson(item)(value)))
    })
  )

export const unsupportedText = "_Dream sent something this version of the app can’t show. Update Dream to see it._"

const MessageHeader = Schema.Struct({ id: MessageId, projectId: ProjectId, createdAt: Schema.DateTimeUtc })

/** The neutral row that stands in for a message the app can't decode, if it at least has an id and a time. */
export const unsupportedMessage = (raw: unknown): Option.Option<TextMessage> =>
  Option.map(decodeJson(MessageHeader)(raw), (header) =>
    TextMessage.make({ ...header, from: "agent", text: unsupportedText, media: [] })
  )

/** A message, or the neutral row in its place. */
export const TolerantMessage = lenient(Message, (raw) =>
  Option.orElse(decodeJson(Message)(raw), (): Option.Option<Message> => unsupportedMessage(raw))
)

const messages = lenientArray(TolerantMessage)

/** `raw` without its `activity`, for a second try when that's the part that didn't decode. */
const withoutActivity = (raw: unknown): Option.Option<unknown> => {
  if (typeof raw !== "object" || raw === null || !("activity" in raw)) return Option.none()
  const { activity: _, ...rest } = raw
  return Option.some(rest)
}

/** Decodes `raw`, else `raw` without its activity. */
const droppingActivity =
  <A>(schema: JsonCodec<A>) =>
  (raw: unknown): Option.Option<A> =>
    Option.orElse(decodeJson(schema)(raw), () => Option.flatMap(withoutActivity(raw), decodeJson(schema)))

const KnownProjectEvent = Schema.TaggedUnion({
  Snapshot: { ...ProjectEvent.cases.Snapshot.fields, messages },
  ProjectChanged: ProjectEvent.cases.ProjectChanged.fields,
  StatusChanged: ProjectEvent.cases.StatusChanged.fields,
  MessageAdded: { message: TolerantMessage },
  MessageChanged: { message: TolerantMessage },
  WorkingChanged: ProjectEvent.cases.WorkingChanged.fields,
  ActivityChanged: ProjectEvent.cases.ActivityChanged.fields,
  Usage: ProjectEvent.cases.Usage.fields
})

/** A project event, or `null` for one the app doesn't know, which `LiveProjects` skips. */
export const TolerantProjectEvent = lenient(Schema.NullOr(KnownProjectEvent), (raw) =>
  Option.orElse(droppingActivity(KnownProjectEvent)(raw), () => Option.some(null))
)

/** A Home row, without its activity if that's what this build can't read. */
const TolerantSummary = lenient(ProjectSummary, droppingActivity(ProjectSummary))

const tolerantSuccess: Partial<Record<RpcGroup.Rpcs<typeof AppRpcs>["_tag"], Schema.Top>> = {
  ListMessages: Schema.Struct({ messages, hasEarlier: Schema.Boolean }),
  ListOpenAsks: lenientArray(OpenAsk),
  ListProjects: lenientArray(TolerantSummary),
  ListIntegrations: lenientArray(Integration),
  // An app or notification in a shape a later API added is left out, rather than the whole sheet.
  GetAppNotifications: Schema.Struct({ apps: lenientArray(AppSender), notifications: lenientArray(AppNotification) })
}

/**
 * `AppRpcs` with the lenient schemas above. They decode to the same types, so it keeps the group's type; the
 * test in `tolerant.test.ts` checks each against the domain's schema.
 */
export const PhoneAppRpcs: typeof AppRpcs = (() => {
  const replaced = Object.entries(tolerantSuccess).flatMap(([tag, schema]) => {
    const rpc = AppRpcs.requests.get(tag)
    return rpc === undefined || schema === undefined ? [] : [rpc.setSuccess(schema)]
  })
  return AppRpcs.add(...replaced) as unknown as typeof AppRpcs
})()

export class PhoneProjectLiveRpcs extends RpcGroup.make(
  Rpc.make("Subscribe", { success: TolerantProjectEvent, stream: true })
) {}
