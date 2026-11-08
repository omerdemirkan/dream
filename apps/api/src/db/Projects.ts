/**
 * Global projections of per-project state (D1): the projects index Home
 * lists, the open-asks deck, the notifications index the app checks for stale
 * ones, the media index, and the machine-minutes ledger. Each ProjectDO keeps
 * its own rows here in sync; nothing else writes them.
 */
import {
  AgentActivity,
  type ArchivedProject,
  AskMessage,
  Harness,
  MediaId,
  MediaRef,
  MessageId,
  NotificationId,
  OpenAsk,
  Project,
  ProjectId,
  ProjectPhase,
  ProjectSummary,
  UsageLimitReached,
  UsageLimits,
  UserId
} from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { randomToken } from "../lib/Ids.ts"
import { decodeFirst, decodeRows, encodeJson, exec, IsoDate, JsonColumn, nowIso, orNull } from "./Sql.ts"

const ProjectRow = Schema.Struct({
  id: ProjectId,
  owner_id: UserId,
  title: Schema.String,
  kind: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  idea: Schema.String,
  harness: Harness,
  phase: ProjectPhase,
  headline: Schema.NullOr(Schema.String),
  slug: Schema.String,
  host: Schema.String,
  public_url: Schema.String,
  published_port: Schema.NullOr(Schema.Int),
  sandbox_id: Schema.NullOr(Schema.String),
  progress_done: Schema.NullOr(Schema.Int),
  progress_total: Schema.NullOr(Schema.Int),
  paused_until: Schema.NullOr(IsoDate),
  open_asks: Schema.Int,
  /** Missing until migration 0007 ran; null until the project's DO first projects it. */
  activity_json: Schema.optionalKey(Schema.NullOr(JsonColumn(AgentActivity))),
  /** Missing until migration 0008 ran; null unless they archived it. */
  archived_at: Schema.optionalKey(Schema.NullOr(IsoDate)),
  /** Missing until migration 0015 ran; null unless they set a usage limit on it. */
  usage_limits_json: Schema.optionalKey(Schema.NullOr(JsonColumn(UsageLimits))),
  /** Missing until migration 0015 ran; null unless a limit they set holds it. */
  paused_by_json: Schema.optionalKey(Schema.NullOr(JsonColumn(UsageLimitReached))),
  created_at: IsoDate,
  updated_at: IsoDate
})
type ProjectRow = typeof ProjectRow.Type

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  ownerId: row.owner_id,
  title: row.title,
  ...(row.kind === null ? {} : { kind: row.kind }),
  ...(row.icon === null ? {} : { icon: row.icon }),
  idea: row.idea,
  harness: row.harness,
  phase: row.phase,
  ...(row.headline === null ? {} : { headline: row.headline }),
  slug: row.slug,
  publicUrl: row.public_url,
  ...(row.published_port === null ? {} : { publishedPort: row.published_port }),
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const toSummary = (row: ProjectRow): ProjectSummary => ({
  project: toProject(row),
  openAsks: row.open_asks,
  ...(row.progress_total === null || row.progress_total === 0
    ? {}
    : { progress: { done: row.progress_done ?? 0, total: row.progress_total } }),
  ...(row.paused_until === null ? {} : { pausedUntil: row.paused_until }),
  ...(row.paused_until === null || row.paused_by_json == null ? {} : { pausedBy: row.paused_by_json }),
  ...(row.activity_json == null ? {} : { activity: row.activity_json })
})

/** What a ProjectDO reports about itself whenever it changes. */
export interface ProjectProjection {
  readonly project: Project
  readonly sandboxId?: string | undefined
  readonly progress?: { readonly done: number; readonly total: number } | undefined
  readonly pausedUntil?: DateTime.Utc | undefined
  readonly pausedBy?: UsageLimitReached | undefined
  /** Absent when neither limit is set. */
  readonly usageLimits?: UsageLimits | undefined
  readonly activity?: AgentActivity | undefined
  readonly openAsks: ReadonlyArray<AskMessage>
}

const MediaRow = Schema.Struct({
  id: MediaId,
  project_id: ProjectId,
  user_id: UserId,
  object_key: Schema.String,
  ref_json: JsonColumn(MediaRef),
  uploaded_at: Schema.NullOr(IsoDate)
})
export type MediaRow = typeof MediaRow.Type

export const UsageKind = Schema.Literals(["sandbox", "browser", "mac"])
export type UsageKind = typeof UsageKind.Type

const stopWords = new Set(
  "a an and app for from i in is it me my of on or our so that the this to we with which who will would want build make me".split(
    " "
  )
)

/** A short, DNS-safe slug from the idea: its first few meaningful words. */
export const slugFromIdea = (idea: string): string => {
  const words = idea
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length > 1 && !stopWords.has(word))
  let slug = ""
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`
    if (next.length > 24) break
    slug = next
    if (slug.split("-").length >= 3) break
  }
  return slug === "" ? "app" : slug
}

// Request phrasing at the start of an idea ("I want you to build me a…"), skipped for the title.
const leadingFiller = new Set(
  "a an the i we you me us my our to want wanted would like need please can could help build make create write lets set up app that which".split(
    " "
  )
)
// Words that start a describing clause ("…that reads Apple Health"); the title stops there.
const clauseStart = new Set("that which who where when with so".split(" "))
// Words a title shouldn't end on.
const trailingFiller = new Set(
  "a an and for from in is it me my of on or our so that the this to we with which who will would when where".split(" ")
)

/**
 * A provisional title from the idea, until the agent names the project: its
 * first few words after any request phrasing, up to any describing clause,
 * in sentence case.
 */
export const titleFromIdea = (idea: string): string => {
  const clause = idea.trim().split(/[.!?;:\n]/)[0] ?? ""
  const words = clause.match(/[\p{L}\p{N}][\p{L}\p{N}'’&+-]*/gu) ?? []
  const start = words.findIndex((word) => !leadingFiller.has(word.toLowerCase().replace(/['’]/g, "")))
  const picked: Array<string> = []
  let length = 0
  for (const word of start === -1 ? [] : words.slice(start)) {
    if (picked.length >= 6 || length + word.length > 36) break
    if (picked.length >= 2 && clauseStart.has(word.toLowerCase())) break
    picked.push(word)
    length += word.length + 1
  }
  while (picked.length > 1 && trailingFiller.has(picked[picked.length - 1]?.toLowerCase() ?? "")) picked.pop()
  const title = picked.join(" ")
  if (title === "") return "Untitled idea"
  // "iOS app" keeps its casing; "recipe app" becomes "Recipe app".
  const first = picked[0] ?? ""
  return first === first.toLowerCase() ? title.charAt(0).toUpperCase() + title.slice(1) : title
}

export class Projects extends Context.Service<
  Projects,
  {
    /** Reserves a unique `<slug>-<random>` host for a new project. */
    readonly allocateHost: (
      idea: string,
      domain: string
    ) => Effect.Effect<{ readonly slug: string; readonly host: string }>
    readonly insert: (project: Project, host: string) => Effect.Effect<void>
    readonly find: (id: ProjectId) => Effect.Effect<Option.Option<Project>>
    /** The project, if it belongs to `userId` (NotFound otherwise is the caller's job). */
    readonly findOwned: (userId: UserId, id: ProjectId) => Effect.Effect<Option.Option<Project>>
    readonly byHost: (
      host: string
    ) => Effect.Effect<Option.Option<{ readonly projectId: ProjectId; readonly ownerId: UserId }>>
    /** Home's rows: their projects but the archived ones. */
    readonly summaries: (userId: UserId) => Effect.Effect<ReadonlyArray<ProjectSummary>>
    readonly summary: (id: ProjectId) => Effect.Effect<Option.Option<ProjectSummary>>
    /** Their archived projects, most recently archived first. */
    readonly archived: (userId: UserId) => Effect.Effect<ReadonlyArray<ArchivedProject>>
    /** Archives the project (`at`) or restores it (`undefined`). Only its DO calls this. */
    readonly setArchived: (id: ProjectId, at: DateTime.Utc | undefined) => Effect.Effect<void>
    readonly projectIdsFor: (userId: UserId) => Effect.Effect<ReadonlyArray<ProjectId>>
    /** Their projects with a usage limit set, for checking them when the plan's usage moves. */
    readonly limitedProjectIdsFor: (userId: UserId) => Effect.Effect<ReadonlyArray<ProjectId>>
    /** The usage limits set on a project, and the one that holds it, as its DO last projected them. */
    readonly usageLimits: (
      id: ProjectId
    ) => Effect.Effect<{ readonly limits?: UsageLimits | undefined; readonly pausedBy?: UsageLimitReached | undefined }>
    /** The sandbox every project records as its own (for the reaper, which never touches these). */
    readonly sandboxIds: Effect.Effect<ReadonlySet<string>>
    /** Replace the projection of one project (its row and its open asks). */
    readonly project: (projection: ProjectProjection) => Effect.Effect<void>
    /** The deck: open asks of their projects but the archived ones. */
    readonly openAsks: (userId: UserId) => Effect.Effect<ReadonlyArray<OpenAsk>>
    /**
     * Removes a deleted project's row and open asks. Its notifications stay, withdrawn, so a phone can still learn
     * they're stale; its usage rows stay as the machine-time record (ids and minutes, nothing of its content).
     */
    readonly remove: (id: ProjectId) => Effect.Effect<void>

    readonly recordNotification: (row: {
      readonly id: NotificationId
      readonly userId: UserId
      readonly projectId: ProjectId
      readonly messageId?: MessageId | undefined
      readonly sentAt: DateTime.Utc
    }) => Effect.Effect<void>
    readonly withdrawNotifications: (ids: ReadonlyArray<NotificationId>, at: DateTime.Utc) => Effect.Effect<void>
    readonly staleNotifications: (
      userId: UserId,
      ids: ReadonlyArray<NotificationId>
    ) => Effect.Effect<ReadonlyArray<NotificationId>>

    readonly insertMedia: (row: {
      readonly ref: MediaRef
      readonly projectId: ProjectId
      readonly userId: UserId
      readonly objectKey: string
    }) => Effect.Effect<void>
    readonly media: (id: MediaId) => Effect.Effect<Option.Option<MediaRow>>
    /** The R2 keys of a project's media. */
    readonly mediaKeys: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<string>>
    readonly removeMedia: (projectId: ProjectId) => Effect.Effect<void>
    readonly markUploaded: (id: MediaId, at: DateTime.Utc) => Effect.Effect<void>

    readonly recordUsage: (row: {
      readonly id: string
      readonly projectId: ProjectId
      readonly userId: UserId
      readonly kind: UsageKind
      readonly ref?: string | undefined
      readonly startedAt: DateTime.Utc
      readonly endedAt: DateTime.Utc
      readonly minutes: number
    }) => Effect.Effect<void>
  }
>()("@dream/api/Projects") {
  static readonly layer = Layer.effect(
    Projects,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const allocateHost = Effect.fn("Projects.allocateHost")(function* (idea: string, domain: string) {
        const slug = slugFromIdea(idea)
        for (let attempt = 0; attempt < 5; attempt++) {
          const host = `${slug}-${randomToken(8, "abcdefghijkmnpqrstuvwxyz23456789")}.${domain}`
          const taken = yield* sql`SELECT id FROM projects WHERE host = ${host}`.pipe(Effect.orDie)
          if (taken.length === 0) return { slug, host }
        }
        return yield* Effect.die("could not allocate a project host")
      })

      const insert = (project: Project, host: string) =>
        exec(sql`
          INSERT INTO projects (id, owner_id, title, kind, icon, idea, harness, phase, headline, slug, host, public_url,
                                published_port, open_asks, created_at, updated_at)
          VALUES (${project.id}, ${project.ownerId}, ${project.title}, ${orNull(project.kind)}, ${orNull(project.icon)},
                  ${project.idea}, ${project.harness}, ${project.phase}, ${orNull(project.headline)}, ${project.slug},
                  ${host}, ${project.publicUrl}, ${orNull(project.publishedPort)}, 0,
                  ${DateTime.formatIso(project.createdAt)}, ${DateTime.formatIso(project.updatedAt)})`)

      const find = (id: ProjectId) =>
        sql`SELECT * FROM projects WHERE id = ${id}`.pipe(
          decodeFirst(ProjectRow),
          Effect.map((row) => Option.map(Option.fromUndefinedOr(row), toProject))
        )

      const findOwned = (userId: UserId, id: ProjectId) =>
        sql`SELECT * FROM projects WHERE id = ${id} AND owner_id = ${userId}`.pipe(
          decodeFirst(ProjectRow),
          Effect.map((row) => Option.map(Option.fromUndefinedOr(row), toProject))
        )

      const byHost = (host: string) =>
        sql`SELECT id, owner_id FROM projects WHERE host = ${host.toLowerCase()}`.pipe(
          decodeFirst(Schema.Struct({ id: ProjectId, owner_id: UserId })),
          Effect.map((row) =>
            Option.map(Option.fromUndefinedOr(row), (found) => ({ projectId: found.id, ownerId: found.owner_id }))
          )
        )

      const summaries = (userId: UserId) =>
        sql`SELECT * FROM projects WHERE owner_id = ${userId} AND archived_at IS NULL ORDER BY updated_at DESC`.pipe(
          decodeRows(ProjectRow),
          Effect.map((rows) => rows.map(toSummary))
        )

      const summary = (id: ProjectId) =>
        sql`SELECT * FROM projects WHERE id = ${id}`.pipe(
          decodeFirst(ProjectRow),
          Effect.map((row) => Option.map(Option.fromUndefinedOr(row), toSummary))
        )

      const archived = (userId: UserId) =>
        sql`SELECT * FROM projects WHERE owner_id = ${userId} AND archived_at IS NOT NULL ORDER BY archived_at DESC`.pipe(
          decodeRows(ProjectRow),
          Effect.map((rows) =>
            rows.flatMap(
              (row): Array<ArchivedProject> =>
                row.archived_at == null ? [] : [{ project: toProject(row), archivedAt: row.archived_at }]
            )
          )
        )

      const setArchived = (id: ProjectId, at: DateTime.Utc | undefined) =>
        exec(
          sql`UPDATE projects SET archived_at = ${at === undefined ? null : DateTime.formatIso(at)} WHERE id = ${id}`
        )

      const projectIdsFor = (userId: UserId) =>
        sql`SELECT id FROM projects WHERE owner_id = ${userId}`.pipe(
          decodeRows(Schema.Struct({ id: ProjectId })),
          Effect.map((rows) => rows.map((row) => row.id))
        )

      const limitedProjectIdsFor = (userId: UserId) =>
        sql`SELECT id FROM projects WHERE owner_id = ${userId} AND usage_limits_json IS NOT NULL`.pipe(
          decodeRows(Schema.Struct({ id: ProjectId })),
          Effect.map((rows) => rows.map((row) => row.id))
        )

      const usageLimits = (id: ProjectId) =>
        sql`SELECT usage_limits_json, paused_by_json, paused_until FROM projects WHERE id = ${id}`.pipe(
          decodeFirst(
            Schema.Struct({
              usage_limits_json: Schema.NullOr(JsonColumn(UsageLimits)),
              paused_by_json: Schema.NullOr(JsonColumn(UsageLimitReached)),
              paused_until: Schema.NullOr(IsoDate)
            })
          ),
          Effect.map((row) => ({
            ...(row?.usage_limits_json == null ? {} : { limits: row.usage_limits_json }),
            ...(row?.paused_by_json == null || row.paused_until === null ? {} : { pausedBy: row.paused_by_json })
          }))
        )

      const sandboxIds = sql`SELECT sandbox_id FROM projects WHERE sandbox_id IS NOT NULL`.pipe(
        decodeRows(Schema.Struct({ sandbox_id: Schema.String })),
        Effect.map((rows) => new Set(rows.map((row) => row.sandbox_id)) as ReadonlySet<string>)
      )

      const project = Effect.fn("Projects.project")(function* (projection: ProjectProjection) {
        const p = projection.project
        const statements = [
          sql`UPDATE projects SET ${sql.update({
            title: p.title,
            kind: orNull(p.kind),
            icon: orNull(p.icon),
            phase: p.phase,
            headline: orNull(p.headline),
            published_port: orNull(p.publishedPort),
            sandbox_id: orNull(projection.sandboxId),
            progress_done: projection.progress?.done ?? null,
            progress_total: projection.progress?.total ?? null,
            paused_until: projection.pausedUntil === undefined ? null : DateTime.formatIso(projection.pausedUntil),
            paused_by_json:
              projection.pausedUntil === undefined || projection.pausedBy === undefined
                ? null
                : encodeJson(UsageLimitReached, projection.pausedBy),
            usage_limits_json:
              projection.usageLimits === undefined ? null : encodeJson(UsageLimits, projection.usageLimits),
            // What needs them now, as ProjectSummary.openAsks says: an access request for later doesn't count yet.
            open_asks: projection.openAsks.filter((ask) => !(ask._tag === "Access" && ask.when)).length,
            activity_json: projection.activity === undefined ? null : encodeJson(AgentActivity, projection.activity),
            updated_at: DateTime.formatIso(p.updatedAt)
          })} WHERE id = ${p.id}`,
          sql`DELETE FROM open_asks WHERE project_id = ${p.id}`,
          ...projection.openAsks.map(
            (ask) => sql`
              INSERT INTO open_asks (message_id, project_id, user_id, message_json, created_at)
              VALUES (${ask.id}, ${p.id}, ${p.ownerId}, ${encodeJson(AskMessage, ask)}, ${DateTime.formatIso(ask.createdAt)})`
          )
        ]
        // The owning ProjectDO serializes its projections, so plain sequential writes are enough here.
        yield* Effect.forEach(statements, exec, { discard: true })
      })

      const openAsks = (userId: UserId) =>
        sql`SELECT p.*, a.message_json AS ask_json FROM open_asks a JOIN projects p ON p.id = a.project_id
            WHERE a.user_id = ${userId} AND p.archived_at IS NULL ORDER BY a.created_at`.pipe(
          decodeRows(Schema.Struct({ ...ProjectRow.fields, ask_json: JsonColumn(AskMessage) })),
          Effect.map((rows) => rows.map((row): OpenAsk => ({ project: toProject(row), message: row.ask_json })))
        )

      const remove = (id: ProjectId) =>
        Effect.gen(function* () {
          yield* exec(sql`DELETE FROM open_asks WHERE project_id = ${id}`)
          yield* exec(sql`DELETE FROM projects WHERE id = ${id}`)
        })

      const recordNotification = (row: {
        readonly id: NotificationId
        readonly userId: UserId
        readonly projectId: ProjectId
        readonly messageId?: MessageId | undefined
        readonly sentAt: DateTime.Utc
      }) =>
        exec(sql`
          INSERT INTO notifications (id, user_id, project_id, message_id, sent_at)
          VALUES (${row.id}, ${row.userId}, ${row.projectId}, ${orNull(row.messageId)}, ${DateTime.formatIso(row.sentAt)})
          ON CONFLICT (id) DO NOTHING`)

      const withdrawNotifications = (ids: ReadonlyArray<NotificationId>, at: DateTime.Utc) =>
        ids.length === 0
          ? Effect.void
          : exec(
              sql`UPDATE notifications SET withdrawn_at = ${DateTime.formatIso(at)} WHERE withdrawn_at IS NULL AND ${sql.in("id", ids)}`
            )

      const staleNotifications = (userId: UserId, ids: ReadonlyArray<NotificationId>) =>
        ids.length === 0
          ? Effect.succeed([])
          : sql`SELECT id FROM notifications WHERE user_id = ${userId} AND withdrawn_at IS NOT NULL AND ${sql.in("id", ids)}`.pipe(
              decodeRows(Schema.Struct({ id: NotificationId })),
              Effect.map((rows) => rows.map((row) => row.id))
            )

      const insertMedia = (row: {
        readonly ref: MediaRef
        readonly projectId: ProjectId
        readonly userId: UserId
        readonly objectKey: string
      }) =>
        Effect.gen(function* () {
          const now = yield* nowIso
          yield* exec(sql`
            INSERT INTO media (id, project_id, user_id, object_key, ref_json, created_at)
            VALUES (${row.ref.id}, ${row.projectId}, ${row.userId}, ${row.objectKey}, ${encodeJson(MediaRef, row.ref)}, ${now})`)
        })

      const media = (id: MediaId) =>
        sql`SELECT * FROM media WHERE id = ${id}`.pipe(decodeFirst(MediaRow), Effect.map(Option.fromUndefinedOr))

      const mediaKeys = (projectId: ProjectId) =>
        sql`SELECT object_key FROM media WHERE project_id = ${projectId}`.pipe(
          decodeRows(Schema.Struct({ object_key: Schema.String })),
          Effect.map((rows) => rows.map((row) => row.object_key))
        )

      const removeMedia = (projectId: ProjectId) => exec(sql`DELETE FROM media WHERE project_id = ${projectId}`)

      const markUploaded = (id: MediaId, at: DateTime.Utc) =>
        exec(sql`UPDATE media SET uploaded_at = ${DateTime.formatIso(at)} WHERE id = ${id}`)

      const recordUsage = (row: {
        readonly id: string
        readonly projectId: ProjectId
        readonly userId: UserId
        readonly kind: UsageKind
        readonly ref?: string | undefined
        readonly startedAt: DateTime.Utc
        readonly endedAt: DateTime.Utc
        readonly minutes: number
      }) =>
        Effect.gen(function* () {
          const now = yield* nowIso
          yield* exec(sql`
            INSERT INTO usage_events (id, project_id, user_id, kind, ref, started_at, ended_at, minutes, created_at)
            VALUES (${row.id}, ${row.projectId}, ${row.userId}, ${row.kind}, ${orNull(row.ref)},
                    ${DateTime.formatIso(row.startedAt)}, ${DateTime.formatIso(row.endedAt)}, ${row.minutes}, ${now})
            ON CONFLICT (id) DO NOTHING`)
        })

      return Projects.of({
        allocateHost,
        insert,
        find,
        findOwned,
        byHost,
        summaries,
        summary,
        archived,
        setArchived,
        projectIdsFor,
        limitedProjectIdsFor,
        usageLimits,
        sandboxIds,
        project,
        openAsks,
        remove,
        recordNotification,
        withdrawNotifications,
        staleNotifications,
        insertMedia,
        media,
        mediaKeys,
        removeMedia,
        markUploaded,
        recordUsage
      })
    })
  )
}
