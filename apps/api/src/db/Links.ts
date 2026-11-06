/**
 * App links (D1 `app_links`): the row of app icons at the top of each person's Home. Rows are per person, with the
 * project a link belongs to. An agent's link they removed stays as a row with `removed_at`, so its agent can't add
 * that URL again; a link they added is deleted outright.
 */
import {
  AppLink,
  LinkAuthor,
  LinkColor,
  LinkIcon,
  LinkId,
  type LinkPart,
  ProjectId,
  UserId,
  linkHost
} from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { decodeFirst, decodeRows, encodeJson, exec, IsoDate, JsonColumn, orNull } from "./Sql.ts"

const LinkRow = Schema.Struct({
  id: LinkId,
  user_id: UserId,
  project_id: Schema.NullOr(ProjectId),
  added_by: LinkAuthor,
  url: Schema.String,
  host: Schema.String,
  title: Schema.String,
  icon_json: Schema.NullOr(JsonColumn(LinkIcon)),
  color: LinkColor,
  their_title: Schema.Int,
  their_icon: Schema.Int,
  created_at: IsoDate,
  updated_at: IsoDate,
  opened_at: Schema.NullOr(IsoDate),
  removed_at: Schema.NullOr(IsoDate)
})
export type LinkRow = typeof LinkRow.Type

export const toAppLink = (row: LinkRow): AppLink => {
  const theirs: Array<LinkPart> = [
    ...(row.their_title ? ["title" as const] : []),
    ...(row.their_icon ? ["icon" as const] : [])
  ]
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    ...(row.icon_json === null ? {} : { icon: row.icon_json }),
    color: row.color,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    addedBy: row.added_by,
    ...(theirs.length === 0 ? {} : { theirs }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.opened_at === null ? {} : { openedAt: row.opened_at }),
    ...(row.removed_at === null ? {} : { removedAt: row.removed_at })
  }
}

/** What changes on a link; absent leaves a field as it is, `icon: null` clears it. */
export interface LinkChanges {
  readonly url?: string | undefined
  readonly title?: string | undefined
  readonly icon?: LinkIcon | null | undefined
  readonly color?: LinkColor | undefined
  readonly theirTitle?: boolean | undefined
  readonly theirIcon?: boolean | undefined
  /** An agent re-pointing its link shows the dot again. */
  readonly unopened?: boolean | undefined
}

export class Links extends Context.Service<
  Links,
  {
    readonly insert: (link: AppLink, userId: UserId) => Effect.Effect<void>
    readonly find: (id: LinkId) => Effect.Effect<Option.Option<LinkRow>>
    /** Home's row: theirs, not removed, leaving out archived projects' links; oldest first. */
    readonly forUser: (userId: UserId) => Effect.Effect<ReadonlyArray<LinkRow>>
    /** A project's links, removed ones included; oldest first. */
    readonly forProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<LinkRow>>
    /** The links on Home that go to `host`, for the gateway. */
    readonly forHost: (host: string) => Effect.Effect<ReadonlyArray<LinkRow>>
    readonly update: (id: LinkId, changes: LinkChanges, at: DateTime.Utc) => Effect.Effect<void>
    /** Keeps the row with `removed_at`, for an agent's link. */
    readonly markRemoved: (id: LinkId, at: DateTime.Utc) => Effect.Effect<void>
    readonly delete: (id: LinkId) => Effect.Effect<void>
    readonly markOpened: (id: LinkId, at: DateTime.Utc) => Effect.Effect<void>
    /** A deleted project's links and their icons. */
    readonly deleteForProject: (projectId: ProjectId) => Effect.Effect<void>
    readonly putIcon: (id: LinkId, png: string, at: DateTime.Utc) => Effect.Effect<void>
    readonly icon: (id: LinkId) => Effect.Effect<Option.Option<string>>
    /** Forgets the drawn tile once the icon or colour changes, until the phone draws it again. */
    readonly dropIcon: (id: LinkId) => Effect.Effect<void>
  }
>()("@dream/api/Links") {
  static readonly layer = Layer.effect(
    Links,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const insert = (link: AppLink, userId: UserId) =>
        exec(sql`
          INSERT INTO app_links (id, user_id, project_id, added_by, url, host, title, icon_json, color, created_at,
                                 updated_at, opened_at)
          VALUES (${link.id}, ${userId}, ${orNull(link.projectId)}, ${link.addedBy}, ${link.url},
                  ${linkHost(link.url).replace(/:\d+$/, "")}, ${link.title},
                  ${link.icon === undefined ? null : encodeJson(LinkIcon, link.icon)}, ${link.color},
                  ${DateTime.formatIso(link.createdAt)}, ${DateTime.formatIso(link.updatedAt)},
                  ${link.openedAt === undefined ? null : DateTime.formatIso(link.openedAt)})`)

      const find = (id: LinkId) =>
        sql`SELECT * FROM app_links WHERE id = ${id}`.pipe(decodeFirst(LinkRow), Effect.map(Option.fromUndefinedOr))

      const forUser = (userId: UserId) =>
        sql`SELECT l.* FROM app_links l LEFT JOIN projects p ON p.id = l.project_id
            WHERE l.user_id = ${userId} AND l.removed_at IS NULL AND p.archived_at IS NULL
            ORDER BY l.created_at, l.id`.pipe(decodeRows(LinkRow))

      const forProject = (projectId: ProjectId) =>
        sql`SELECT * FROM app_links WHERE project_id = ${projectId} ORDER BY created_at, id`.pipe(decodeRows(LinkRow))

      const forHost = (host: string) =>
        sql`SELECT * FROM app_links WHERE host = ${host.toLowerCase()} AND removed_at IS NULL ORDER BY created_at`.pipe(
          decodeRows(LinkRow)
        )

      const update = (id: LinkId, changes: LinkChanges, at: DateTime.Utc) =>
        exec(
          sql`UPDATE app_links SET ${sql.update({
            ...(changes.url === undefined
              ? {}
              : { url: changes.url, host: linkHost(changes.url).replace(/:\d+$/, "") }),
            ...(changes.title === undefined ? {} : { title: changes.title }),
            ...(changes.icon === undefined
              ? {}
              : { icon_json: changes.icon === null ? null : encodeJson(LinkIcon, changes.icon) }),
            ...(changes.color === undefined ? {} : { color: changes.color }),
            ...(changes.theirTitle ? { their_title: 1 } : {}),
            ...(changes.theirIcon ? { their_icon: 1 } : {}),
            ...(changes.unopened ? { opened_at: null } : {}),
            updated_at: DateTime.formatIso(at)
          })} WHERE id = ${id}`
        )

      const markRemoved = (id: LinkId, at: DateTime.Utc) =>
        exec(sql`UPDATE app_links SET removed_at = ${DateTime.formatIso(at)} WHERE id = ${id}`)

      const remove = (id: LinkId) =>
        Effect.gen(function* () {
          yield* exec(sql`DELETE FROM app_link_icons WHERE link_id = ${id}`)
          yield* exec(sql`DELETE FROM app_links WHERE id = ${id}`)
        })

      const markOpened = (id: LinkId, at: DateTime.Utc) =>
        exec(sql`UPDATE app_links SET opened_at = ${DateTime.formatIso(at)} WHERE id = ${id} AND opened_at IS NULL`)

      const deleteForProject = (projectId: ProjectId) =>
        Effect.gen(function* () {
          yield* exec(
            sql`DELETE FROM app_link_icons WHERE link_id IN (SELECT id FROM app_links WHERE project_id = ${projectId})`
          )
          yield* exec(sql`DELETE FROM app_links WHERE project_id = ${projectId}`)
        })

      const putIcon = (id: LinkId, png: string, at: DateTime.Utc) =>
        exec(sql`
          INSERT INTO app_link_icons (link_id, png, updated_at) VALUES (${id}, ${png}, ${DateTime.formatIso(at)})
          ON CONFLICT (link_id) DO UPDATE SET png = excluded.png, updated_at = excluded.updated_at`)

      const icon = (id: LinkId) =>
        sql`SELECT png FROM app_link_icons WHERE link_id = ${id}`.pipe(
          decodeFirst(Schema.Struct({ png: Schema.String })),
          Effect.map((row) => Option.map(Option.fromUndefinedOr(row), (found) => found.png))
        )

      const dropIcon = (id: LinkId) => exec(sql`DELETE FROM app_link_icons WHERE link_id = ${id}`)

      return Links.of({
        insert,
        find,
        forUser,
        forProject,
        forHost,
        update,
        markRemoved,
        delete: remove,
        markOpened,
        deleteForProject,
        putIcon,
        icon,
        dropIcon
      })
    })
  )
}
