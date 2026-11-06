/**
 * App links on Home end to end, in memory: the agent's `dream link` calls and the phone's, the choices of theirs
 * that stick, what the agent hears, archive and delete, and what the gateway serves for Add to Home Screen.
 */
import { assert, describe, it } from "@effect/vitest"
import { type AgentEvent, type AppLink, DaemonEnvFile, type LinkId, type ProjectId, RequestId } from "@dream/domain"
import { DateTime, Effect, Redacted } from "effect"
import { Links } from "../src/db/Links.ts"
import { DreamAssets, gateway, homeScreenHead, linkForPath, previewTags } from "../src/http/Gateway.ts"
import { makeCloud } from "./support/Cloud.ts"

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
const claudeToken = `sk-ant-oat01-${"x".repeat(60)}`

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const setup = (cloud: Cloud) =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({ email: "ada@example.com", secret: Redacted.make("dev-secret") })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
    cloud.world.scripts.set("claude setup-token", [
      { _tag: "Output", text: `Use the url below\r\n${claudeUrl}\r\n` },
      { _tag: "Output", text: "Paste code here if prompted > " }
    ])
    const started = yield* cloud.phone.StartModelConnection({ provider: "claude" })
    cloud.world.attachOutput = [
      { _tag: "Output", text: "Long-lived authentication token created successfully!\r\n" },
      { _tag: "Output", text: `${claudeToken}\r\n` }
    ]
    yield* cloud.phone.CompleteModelConnection({
      connectionId: started.connection.id,
      code: Redacted.make("code123#state")
    })
    const project = yield* cloud.phone.CreateProject({ idea: "A strength log that tells me when to add weight." })
    yield* cloud.alarm(project.id)
    const dreamd = yield* cloud.sandbox(tokenOf(cloud, project.id))
    return { project, dreamd }
  })

const tokenOf = (cloud: Cloud, projectId: ProjectId): string => {
  const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  const line = sandbox.files
    .get(DaemonEnvFile)!
    .split("\n")
    .find((l) => l.startsWith("DREAM_PROJECT_TOKEN="))!
  return JSON.parse(line.slice("DREAM_PROJECT_TOKEN=".length))
}

const linkEvents = (cloud: Cloud) =>
  cloud.world.delivered.flatMap((d) => d.events as ReadonlyArray<AgentEvent>).filter((e) => e._tag === "LinkEdited")

/** A link they added themselves, as the app let them before only agents made links. */
const handAdded = (
  cloud: Cloud,
  input: { readonly url: string; readonly title: string; readonly projectId?: ProjectId }
) =>
  Effect.gen(function* () {
    const user = yield* cloud.phone.GetMe()
    const now = yield* DateTime.now
    const link: AppLink = {
      id: `lnk_hand${Math.random().toString(36).slice(2, 10)}` as LinkId,
      url: input.url,
      title: input.title,
      color: "light",
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      addedBy: "person",
      createdAt: now,
      updatedAt: now,
      openedAt: now
    }
    yield* Links.use((links) => links.insert(link, user.id)).pipe(Effect.provideContext(cloud.workerContext))
    return link
  })

const bodyText = (response: { readonly body: unknown }) => {
  const body = response.body as { readonly _tag: string; readonly body?: Uint8Array }
  return body._tag === "Uint8Array" && body.body !== undefined ? new TextDecoder().decode(body.body) : ""
}

describe("app links", () => {
  it.live("the agent adds a link, which shows on their Home with the project's name", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const added = yield* dreamd.AddLink({
        url: project.publicUrl,
        title: "Lift Log",
        icon: { _tag: "Symbol", name: "dumbbell" },
        color: "purple"
      })
      assert.strictEqual(added.link.addedBy, "agent")
      assert.strictEqual(added.link.projectId, project.id)
      assert.isUndefined(added.link.openedAt)
      assert.strictEqual(added.projectTitle, project.title)
      const [shown] = yield* cloud.phone.ListLinks()
      assert.strictEqual(shown?.id, added.link.id)

      // Opening it takes the dot away.
      yield* cloud.phone.MarkLinkOpened({ linkId: added.link.id })
      assert.isDefined((yield* cloud.phone.ListLinks())[0]?.openedAt)

      // The same URL twice, and more than three, are refused.
      const twice = yield* Effect.flip(dreamd.AddLink({ url: `${project.publicUrl}/`, title: "Again", color: "blue" }))
      assert.include(twice.message, "already goes there")
      yield* dreamd.AddLink({ url: `${project.publicUrl}/history`, title: "History", color: "blue" })
      yield* dreamd.AddLink({ url: `${project.publicUrl}/timer`, title: "Timer", color: "red" })
      const fourth = yield* Effect.flip(
        dreamd.AddLink({ url: `${project.publicUrl}/plan`, title: "Plan", color: "red" })
      )
      assert.include(fourth.message, "the most one project gets")
      yield* cloud.close
    })
  )

  it.live("what they rename, re-icon or remove stays theirs, and the agent hears", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const { link } = yield* dreamd.AddLink({ url: project.publicUrl, title: "Lift Log", color: "purple" })

      const renamed = yield* cloud.phone.UpdateLink({ linkId: link.id, title: "Lifts" })
      assert.deepStrictEqual(renamed.theirs, ["title"])
      const refused = yield* Effect.flip(dreamd.UpdateLink({ linkId: link.id, title: "Lift Log" }))
      assert.include(refused.message, "renamed this link")
      // Its icon is still the agent's to change.
      const reiconed = yield* dreamd.UpdateLink({ linkId: link.id, icon: { _tag: "Emoji", emoji: "🏋️" } })
      assert.strictEqual(reiconed.link.title, "Lifts")

      yield* cloud.phone.UpdateLink({ linkId: link.id, color: "red" })
      const iconRefused = yield* Effect.flip(dreamd.UpdateLink({ linkId: link.id, color: "blue" }))
      assert.include(iconRefused.message, "chose this link's icon")

      yield* cloud.phone.RemoveLink({ linkId: link.id })
      assert.lengthOf(yield* cloud.phone.ListLinks(), 0)
      const back = yield* Effect.flip(dreamd.AddLink({ url: project.publicUrl, title: "Lift Log", color: "purple" }))
      assert.include(back.message, "They removed your link")
      const listed = yield* dreamd.ListLinks()
      assert.isDefined(listed.links[0]?.removedAt)

      yield* cloud.alarm(project.id)
      const events = linkEvents(cloud)
      assert.deepStrictEqual(
        events.map((e) => (e._tag === "LinkEdited" ? e.change : "")),
        ["renamed", "icon", "removed"]
      )
      const icon = events[1]
      assert.strictEqual(icon?._tag === "LinkEdited" ? icon.tile : "", "🏋️ on a red tile")
      yield* cloud.close
    })
  )

  it.live("they put back an agent's link they removed, and its agent can change it again", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const { link } = yield* dreamd.AddLink({ url: project.publicUrl, title: "Lift Log", color: "purple" })
      yield* cloud.phone.UpdateLink({ linkId: link.id, title: "Lifts" })
      assert.lengthOf(yield* cloud.phone.ListRemovedLinks(), 0)
      yield* cloud.phone.RemoveLink({ linkId: link.id })
      const removed = yield* cloud.phone.ListRemovedLinks()
      assert.deepStrictEqual(
        removed.map((l) => l.id),
        [link.id]
      )
      assert.isDefined(removed[0]?.removedAt)

      const back = yield* cloud.phone.RestoreLink({ linkId: link.id })
      assert.isUndefined(back.removedAt)
      assert.strictEqual(back.title, "Lifts")
      assert.deepStrictEqual(back.theirs, ["title"])
      assert.deepStrictEqual(
        (yield* cloud.phone.ListLinks()).map((l) => l.id),
        [link.id]
      )
      assert.lengthOf(yield* cloud.phone.ListRemovedLinks(), 0)
      // Again is harmless; the agent can point it elsewhere, but the name stays theirs.
      assert.strictEqual((yield* cloud.phone.RestoreLink({ linkId: link.id })).id, link.id)
      const moved = yield* dreamd.UpdateLink({ linkId: link.id, url: `${project.publicUrl}/today` })
      assert.strictEqual(moved.link.url, `${project.publicUrl}/today`)

      // An archived project's removed links aren't offered or restored until it's back.
      yield* cloud.phone.RemoveLink({ linkId: link.id })
      yield* cloud.phone.ArchiveProject({ projectId: project.id })
      assert.lengthOf(yield* cloud.phone.ListRemovedLinks(), 0)
      assert.strictEqual((yield* Effect.flip(cloud.phone.RestoreLink({ linkId: link.id })))._tag, "NotFound")
      yield* cloud.phone.RestoreProject({ projectId: project.id })
      assert.lengthOf(yield* cloud.phone.ListRemovedLinks(), 1)
      yield* cloud.close
    })
  )

  it.live("they can't add links themselves any more; the ones they added before keep working", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const refused = yield* Effect.flip(
        cloud.phone.AddLink({
          url: "https://trains.example.com/eus",
          title: "Train times",
          color: "light",
          requestId: RequestId.make("0b3f8a5e-2f4c-4f1e-9b8e-1f2a3b4c5d6e")
        })
      )
      assert.strictEqual(refused._tag, "InvalidRequest")
      assert.include(refused.message, "Update Dream")
      assert.lengthOf(yield* cloud.phone.ListLinks(), 0)

      const mine = yield* handAdded(cloud, { url: `${project.publicUrl}/admin`, title: "Admin", projectId: project.id })
      const renamed = yield* cloud.phone.UpdateLink({ linkId: mine.id, title: "Admin page" })
      assert.isUndefined(renamed.theirs)
      const image = yield* Effect.flip(
        cloud.phone.UpdateLink({
          linkId: mine.id,
          icon: {
            _tag: "Image",
            media: { id: "med_x" as never, kind: "image", contentType: "image/png", sizeBytes: 1 }
          }
        })
      )
      assert.strictEqual(image._tag, "InvalidRequest")
      const theirs = yield* Effect.flip(dreamd.UpdateLink({ linkId: mine.id, title: "Mine" }))
      assert.include(theirs.message, "added")
      // Removing one deletes it: it isn't offered back.
      yield* cloud.phone.RemoveLink({ linkId: mine.id })
      assert.lengthOf(yield* cloud.phone.ListLinks(), 0)
      assert.lengthOf(yield* cloud.phone.ListRemovedLinks(), 0)
      yield* cloud.close
    })
  )

  it.live("an archived project's links leave Home until it's back; a deleted one's go", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      yield* dreamd.AddLink({ url: project.publicUrl, title: "Lift Log", color: "purple" })
      yield* handAdded(cloud, { url: "https://trains.example.com", title: "Trains" })
      yield* cloud.phone.ArchiveProject({ projectId: project.id })
      assert.deepStrictEqual(
        (yield* cloud.phone.ListLinks()).map((l) => l.title),
        ["Trains"]
      )
      yield* cloud.phone.RestoreProject({ projectId: project.id })
      assert.lengthOf(yield* cloud.phone.ListLinks(), 2)
      yield* cloud.phone.DeleteProject({ projectId: project.id })
      assert.deepStrictEqual(
        (yield* cloud.phone.ListLinks()).map((l) => l.title),
        ["Trains"]
      )
      yield* cloud.close
    })
  )

  it.live("Add to Home Screen: a hinted URL, then the gateway's manifest and icon", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const { link } = yield* dreamd.AddLink({ url: project.publicUrl, title: "Lift Log", color: "purple" })
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
      const bad = yield* Effect.flip(cloud.phone.PrepareHomeScreen({ linkId: link.id, iconPng: "not a png" }))
      assert.strictEqual(bad._tag, "InvalidRequest")
      const { url } = yield* cloud.phone.PrepareHomeScreen({ linkId: link.id, iconPng: png })
      assert.strictEqual(url, `${project.publicUrl}?dream_home_screen=1`)
      const other = yield* handAdded(cloud, { url: "https://trains.example.com/#/eus", title: "Trains" })
      assert.strictEqual((yield* cloud.phone.PrepareHomeScreen({ linkId: other.id })).url, other.url)

      const host = new URL(project.publicUrl).host
      const get = (path: string) =>
        gateway(host, new Request(`${project.publicUrl}${path}`)).pipe(Effect.provideContext(cloud.workerContext))
      const manifest = yield* get(`${DreamAssets}manifest/${link.id}.webmanifest`)
      assert.strictEqual(manifest.status, 200)
      const parsed = JSON.parse(bodyText(manifest))
      assert.strictEqual(parsed.name, "Lift Log")
      assert.strictEqual(parsed.start_url, project.publicUrl)
      assert.strictEqual(parsed.icons[0].src, `${DreamAssets}icon/${link.id}.png`)
      const icon = yield* get(`${DreamAssets}icon/${link.id}.png`)
      assert.strictEqual(icon.status, 200)
      assert.strictEqual(icon.headers["content-type"], "image/png")
      const missing = yield* get(`${DreamAssets}icon/lnk_nothing.png`)
      assert.strictEqual(missing.status, 404)
      yield* cloud.close
    })
  )

  it("puts the link's name and icon in the page's head, and the steps only when asked", () => {
    const plain = homeScreenHead({ id: "lnk_a" as never, title: `Tom's "Lifts" <b>` }, { hasIcon: false, hint: false })
    assert.strictEqual(plain.first, "")
    assert.include(plain.last, 'content="Tom&#39;s &quot;Lifts&quot; &lt;b&gt;"')
    assert.notInclude(plain.last, "apple-touch-icon")
    const hinted = homeScreenHead({ id: "lnk_a" as never, title: "</script>Lift" }, { hasIcon: true, hint: true })
    assert.include(hinted.last, `${DreamAssets}icon/lnk_a.png`)
    assert.notInclude(hinted.first.slice(8, -9), "</script>")
    // The script is valid JavaScript.
    assert.doesNotThrow(() => new Function(hinted.first.slice("<script>".length, -"</script>".length)))
  })

  it("gives the page a preview title and image where it has none of its own", () => {
    const link = { id: "lnk_a" as never, title: `Tom's <Lifts>` }
    const origin = "https://lift-ab12.example.com"
    const both = previewTags(link, { origin, hasIcon: true, ownTitle: false, ownImage: false })
    assert.include(both, '<meta property="og:title" content="Tom&#39;s &lt;Lifts&gt;">')
    assert.include(both, `<meta property="og:image" content="${origin}${DreamAssets}icon/lnk_a.png">`)
    assert.notInclude(previewTags(link, { origin, hasIcon: false, ownTitle: false, ownImage: false }), "og:image")
    assert.strictEqual(previewTags(link, { origin, hasIcon: true, ownTitle: true, ownImage: true }), "")
  })

  it("matches a page to the link with the longest path", () => {
    const rows = [{ url: "https://a.example.com" }, { url: "https://a.example.com/admin" }]
    assert.strictEqual(linkForPath(rows, "/admin/users"), rows[1])
    assert.strictEqual(linkForPath(rows, "/administer"), rows[0])
    assert.strictEqual(linkForPath(rows, "/"), rows[0])
    assert.isUndefined(linkForPath([rows[1]!], "/"))
  })
})
