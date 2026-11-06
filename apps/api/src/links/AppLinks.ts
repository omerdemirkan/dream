/**
 * App links on Home: what the phone (`AppRpcs`) and the agent (`SandboxRpcs`, `dream link`) may do to them, over
 * D1's `app_links`. The rules that make the person's choices stick live here: a title or icon they changed on an
 * agent's link stays theirs, an agent's link they removed can't come back from the agent (only they can put it
 * back), and the agent hears about each of these (`AgentEvent.LinkEdited`). Only agents make links now; the ones
 * people added themselves before that keep working until they remove them.
 */
import {
  AgentLinksPerProject,
  type AppLink,
  describeLinkTile,
  InvalidRequest,
  type LinkColor,
  type LinkIcon,
  type LinkId,
  linkHost,
  NotFound,
  type ProjectId,
  type ProjectLink,
  type ProjectLinks,
  type UserId
} from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option } from "effect"
import { type LinkChanges, type LinkRow, Links, toAppLink } from "../db/Links.ts"
import { Projects } from "../db/Projects.ts"
import { newLinkId } from "../lib/Ids.ts"
import { ProjectClients } from "../project/Client.ts"

/** The query parameter that makes the gateway point at Safari's steps once (H2 in the mocks). */
export const HomeScreenHintParam = "dream_home_screen"

/** The largest tile png the phone may send for the Home Screen icon, decoded. */
const MaxIconBytes = 1_400_000

const notFound = (id: string) => new NotFound({ entity: "link", id })
const invalid = (message: string) => new InvalidRequest({ message })

/** URLs that differ only by a trailing slash are the same link. */
const sameUrl = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "")

const sameIcon = (a: LinkIcon | undefined, b: LinkIcon | null | undefined) => {
  if (a === undefined || b == null) return a === undefined && b == null
  if (a._tag !== b._tag) return false
  if (a._tag === "Image" && b._tag === "Image") return a.media.id === b.media.id
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Whether `text` is a base64 png of a sensible size. */
const isPngBase64 = (text: string) =>
  /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.startsWith("iVBORw0KGgo") && (text.length * 3) / 4 <= MaxIconBytes

/** What `AddLink` answers, for builds from before hand-added links went. */
export const NoHandAddedLinks = new InvalidRequest({
  message: "Only your projects add apps to Home now. Update Dream to put back one you removed."
})

export interface AgentLinkInput {
  readonly url: string
  readonly title: string
  readonly icon?: LinkIcon | undefined
  readonly color: LinkColor
}

export class AppLinks extends Context.Service<
  AppLinks,
  {
    readonly list: (userId: UserId) => Effect.Effect<ReadonlyArray<AppLink>>
    readonly listRemoved: (userId: UserId) => Effect.Effect<ReadonlyArray<AppLink>>
    readonly restore: (userId: UserId, linkId: LinkId) => Effect.Effect<AppLink, NotFound>
    readonly update: (
      userId: UserId,
      linkId: LinkId,
      changes: { readonly title?: string; readonly icon?: LinkIcon | null; readonly color?: LinkColor }
    ) => Effect.Effect<AppLink, NotFound | InvalidRequest>
    readonly remove: (userId: UserId, linkId: LinkId) => Effect.Effect<void, NotFound>
    readonly markOpened: (userId: UserId, linkId: LinkId) => Effect.Effect<void, NotFound>
    readonly prepareHomeScreen: (
      userId: UserId,
      linkId: LinkId,
      iconPng: string | undefined
    ) => Effect.Effect<{ readonly url: string }, NotFound | InvalidRequest>

    readonly listForAgent: (projectId: ProjectId) => Effect.Effect<ProjectLinks>
    readonly addByAgent: (
      projectId: ProjectId,
      userId: UserId,
      input: AgentLinkInput
    ) => Effect.Effect<ProjectLink, InvalidRequest>
    readonly updateByAgent: (
      projectId: ProjectId,
      linkId: LinkId,
      changes: {
        readonly url?: string
        readonly title?: string
        readonly icon?: LinkIcon | null
        readonly color?: LinkColor
      }
    ) => Effect.Effect<ProjectLink, NotFound | InvalidRequest>
    readonly removeByAgent: (projectId: ProjectId, linkId: LinkId) => Effect.Effect<void, NotFound | InvalidRequest>
  }
>()("@dream/api/AppLinks") {
  static readonly layer = Layer.effect(
    AppLinks,
    Effect.gen(function* () {
      const links = yield* Links
      const projects = yield* Projects
      const clients = yield* ProjectClients

      const owned = (userId: UserId, linkId: LinkId) =>
        Effect.flatMap(links.find(linkId), (row) =>
          Option.isSome(row) && row.value.user_id === userId && row.value.removed_at === null
            ? Effect.succeed(row.value)
            : Effect.fail(notFound(linkId))
        )

      const reread = (linkId: LinkId) =>
        Effect.flatMap(links.find(linkId), (row) =>
          Option.match(row, { onNone: () => Effect.die("link vanished"), onSome: (found) => Effect.succeed(found) })
        )

      /** The project whose public host `url` is on, if it's theirs. */
      const projectOfUrl = (userId: UserId, url: string) =>
        Effect.map(projects.byHost(linkHost(url).replace(/:\d+$/, "")), (found) =>
          Option.filter(found, (p) => p.ownerId === userId)
        )

      /** The project's name and public URL, as `dream link` echoes them. */
      const about = (projectId: ProjectId) =>
        Effect.map(projects.find(projectId), (found) =>
          Option.match(found, {
            onNone: () => ({ projectTitle: "this project", publicUrl: "" }),
            onSome: (p) => ({ projectTitle: p.title, publicUrl: p.publicUrl })
          })
        )

      /** An agent's link changed by them: its agent hears. Delivery problems don't fail their edit. */
      const tell = (
        row: LinkRow,
        change: { readonly change: "renamed" | "icon" | "removed"; readonly title: string } & {
          readonly previousTitle?: string
          readonly tile?: string
        }
      ) =>
        row.added_by !== "agent" || row.project_id === null
          ? Effect.void
          : clients
              .use(row.project_id, (client) => client.LinkEdited({ linkId: row.id, url: row.url, ...change }))
              .pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't tell the agent about a link", cause)))

      /** Their image icon can stay, but they can't set one: the phone has no way to upload it. */
      const personIcon = (icon: LinkIcon | null | undefined, current: LinkIcon | undefined) =>
        icon != null && icon._tag === "Image" && !sameIcon(current, icon)
          ? Effect.fail(invalid("Pick a symbol or an emoji for the icon."))
          : Effect.void

      const list = (userId: UserId) => Effect.map(links.forUser(userId), (rows) => rows.map(toAppLink))

      const listRemoved = (userId: UserId) =>
        Effect.map(links.removedForUser(userId), (rows) =>
          rows.filter((row) => row.added_by === "agent").map(toAppLink)
        )

      const restore = Effect.fn("AppLinks.restore")(function* (userId: UserId, linkId: LinkId) {
        const row = yield* links.find(linkId)
        if (Option.isNone(row) || row.value.user_id !== userId || row.value.added_by !== "agent") {
          return yield* notFound(linkId)
        }
        if (row.value.removed_at === null) return toAppLink(row.value)
        // Not offered while its project is archived, so not restored then either.
        if (!(yield* links.removedForUser(userId)).some((r) => r.id === linkId)) return yield* notFound(linkId)
        yield* links.markRestored(linkId, yield* DateTime.now)
        return toAppLink(yield* reread(linkId))
      })

      const update = Effect.fn("AppLinks.update")(function* (
        userId: UserId,
        linkId: LinkId,
        changes: { readonly title?: string; readonly icon?: LinkIcon | null; readonly color?: LinkColor }
      ) {
        const row = yield* owned(userId, linkId)
        const current = toAppLink(row)
        yield* personIcon(changes.icon, current.icon)
        const renamed = changes.title !== undefined && changes.title !== row.title
        const reiconed =
          (changes.icon !== undefined && !sameIcon(current.icon, changes.icon)) ||
          (changes.color !== undefined && changes.color !== row.color)
        if (!renamed && !reiconed) return current
        const agents = row.added_by === "agent"
        const now = yield* DateTime.now
        yield* links.update(
          linkId,
          {
            ...(renamed ? { title: changes.title, theirTitle: agents } : {}),
            ...(reiconed ? { icon: changes.icon, color: changes.color, theirIcon: agents } : {})
          },
          now
        )
        if (reiconed) yield* links.dropIcon(linkId)
        const updated = toAppLink(yield* reread(linkId))
        if (renamed) yield* tell(row, { change: "renamed", title: updated.title, previousTitle: row.title })
        if (reiconed) yield* tell(row, { change: "icon", title: updated.title, tile: describeLinkTile(updated) })
        return updated
      })

      const remove = Effect.fn("AppLinks.remove")(function* (userId: UserId, linkId: LinkId) {
        const row = yield* owned(userId, linkId)
        if (row.added_by === "agent") {
          yield* links.markRemoved(linkId, yield* DateTime.now)
          yield* tell(row, { change: "removed", title: row.title })
        } else {
          yield* links.delete(linkId)
        }
      })

      const markOpened = Effect.fn("AppLinks.markOpened")(function* (userId: UserId, linkId: LinkId) {
        yield* owned(userId, linkId)
        yield* links.markOpened(linkId, yield* DateTime.now)
      })

      const prepareHomeScreen = Effect.fn("AppLinks.prepareHomeScreen")(function* (
        userId: UserId,
        linkId: LinkId,
        iconPng: string | undefined
      ) {
        const row = yield* owned(userId, linkId)
        if (iconPng !== undefined) {
          if (!isPngBase64(iconPng)) return yield* invalid("The icon has to be a png.")
          yield* links.putIcon(linkId, iconPng, yield* DateTime.now)
        }
        // Only Dream's gateway can show the steps, on a published app's own page.
        const published = Option.isSome(yield* projectOfUrl(userId, row.url))
        if (!published) return { url: row.url }
        const hash = row.url.indexOf("#")
        const base = hash === -1 ? row.url : row.url.slice(0, hash)
        const fragment = hash === -1 ? "" : row.url.slice(hash)
        return { url: `${base}${base.includes("?") ? "&" : "?"}${HomeScreenHintParam}=1${fragment}` }
      })

      // The agent's side --------------------------------------------------------------------------

      const listForAgent = Effect.fn("AppLinks.listForAgent")(function* (projectId: ProjectId) {
        const rows = yield* links.forProject(projectId)
        return { links: rows.map(toAppLink), ...(yield* about(projectId)) }
      })

      const removedByThem = (rows: ReadonlyArray<LinkRow>, url: string) =>
        rows.find((row) => row.added_by === "agent" && row.removed_at !== null && sameUrl(row.url, url))

      const refuseRemoved = (row: LinkRow | undefined) =>
        row === undefined || row.removed_at === null
          ? Effect.void
          : Effect.fail(
              invalid(
                `They removed your link to ${row.url} ("${row.title}") from their Home on ` +
                  `${DateTime.formatIso(row.removed_at).slice(0, 10)}, so it stays off. They can put it back themselves.`
              )
            )

      /** An image icon must be this project's own upload. */
      const agentIcon = (projectId: ProjectId, icon: LinkIcon | null | undefined) =>
        Effect.gen(function* () {
          if (icon == null || icon._tag !== "Image") return icon
          const media = yield* projects.media(icon.media.id)
          if (Option.isNone(media) || media.value.project_id !== projectId || media.value.uploaded_at === null) {
            return yield* invalid("That icon image isn't an upload of this project's. Pass the file to --icon.")
          }
          if (media.value.ref_json.kind !== "image") return yield* invalid("The icon has to be a png or jpg.")
          return { _tag: "Image" as const, media: media.value.ref_json }
        })

      const addByAgent = Effect.fn("AppLinks.addByAgent")(function* (
        projectId: ProjectId,
        userId: UserId,
        input: AgentLinkInput
      ) {
        const rows = yield* links.forProject(projectId)
        yield* refuseRemoved(removedByThem(rows, input.url))
        const live = rows.filter((row) => row.removed_at === null)
        const same = live.find((row) => sameUrl(row.url, input.url))
        if (same !== undefined) {
          return yield* invalid(
            same.added_by === "agent"
              ? `Your link ${same.id} ("${same.title}") already goes there. Change it with \`dream link update ${same.id}\`.`
              : `They already have a link to ${same.url} on Home ("${same.title}"), added themselves.`
          )
        }
        const mine = live.filter((row) => row.added_by === "agent")
        if (mine.length >= AgentLinksPerProject) {
          return yield* invalid(
            `This project already has ${mine.length} links on their Home (${mine.map((row) => `${row.id} "${row.title}"`).join(", ")}), ` +
              `the most one project gets. Remove one or point it somewhere else first.`
          )
        }
        const icon = yield* agentIcon(projectId, input.icon)
        const now = yield* DateTime.now
        const link: AppLink = {
          id: yield* newLinkId(),
          url: input.url,
          title: input.title,
          ...(icon == null ? {} : { icon }),
          color: input.color,
          projectId,
          addedBy: "agent",
          createdAt: now,
          updatedAt: now
        }
        yield* links.insert(link, userId)
        return { link, ...(yield* about(projectId)) }
      })

      const agentsOwn = (projectId: ProjectId, linkId: LinkId) =>
        Effect.gen(function* () {
          const row = yield* links.find(linkId)
          if (Option.isNone(row) || row.value.project_id !== projectId) return yield* notFound(linkId)
          if (row.value.removed_at !== null) return yield* refuseRemoved(row.value).pipe(Effect.as(row.value))
          if (row.value.added_by !== "agent") {
            return yield* invalid(`They added "${row.value.title}" themselves, so it's theirs to change.`)
          }
          return row.value
        })

      const updateByAgent = Effect.fn("AppLinks.updateByAgent")(function* (
        projectId: ProjectId,
        linkId: LinkId,
        changes: {
          readonly url?: string
          readonly title?: string
          readonly icon?: LinkIcon | null
          readonly color?: LinkColor
        }
      ) {
        const row = yield* agentsOwn(projectId, linkId)
        const current = toAppLink(row)
        const retitled = changes.title !== undefined && changes.title !== row.title
        const reiconed =
          (changes.icon !== undefined && !sameIcon(current.icon, changes.icon)) ||
          (changes.color !== undefined && changes.color !== row.color)
        const moved = changes.url !== undefined && !sameUrl(changes.url, row.url)
        if (retitled && row.their_title) {
          return yield* invalid(`They renamed this link "${row.title}" themselves, so the name stays theirs.`)
        }
        if (reiconed && row.their_icon) {
          return yield* invalid(`They chose this link's icon themselves (${describeLinkTile(current)}), so it stays.`)
        }
        if (moved) {
          const rows = yield* links.forProject(projectId)
          yield* refuseRemoved(removedByThem(rows, changes.url!))
          const clash = rows.find(
            (other) => other.id !== linkId && other.removed_at === null && sameUrl(other.url, changes.url!)
          )
          if (clash !== undefined) return yield* invalid(`"${clash.title}" (${clash.id}) already goes to ${clash.url}.`)
        }
        const icon = yield* agentIcon(projectId, changes.icon)
        const update: LinkChanges = {
          ...(moved ? { url: changes.url, unopened: true } : {}),
          ...(retitled ? { title: changes.title } : {}),
          ...(reiconed ? { icon, color: changes.color } : {})
        }
        if (Object.keys(update).length > 0) {
          const now = yield* DateTime.now
          yield* links.update(linkId, update, now)
          if (reiconed) yield* links.dropIcon(linkId)
        }
        return { link: toAppLink(yield* reread(linkId)), ...(yield* about(projectId)) }
      })

      const removeByAgent = Effect.fn("AppLinks.removeByAgent")(function* (projectId: ProjectId, linkId: LinkId) {
        yield* agentsOwn(projectId, linkId)
        yield* links.delete(linkId)
      })

      return AppLinks.of({
        list,
        listRemoved,
        restore,
        update,
        remove,
        markOpened,
        prepareHomeScreen,
        listForAgent,
        addByAgent,
        updateByAgent,
        removeByAgent
      })
    })
  )
}
