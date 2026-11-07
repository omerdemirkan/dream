/**
 * Finishing an access request on a computer: the phone asks for the email (`EmailAccessLink`), the person opens
 * the link in a browser, and what they submit there connects the request exactly as the phone would. Also what
 * the link is held to: one browser, once, for 30 minutes, only while the request waits, and nothing secret in
 * the email, the URLs or the stored rows.
 */
import { assert, describe, it } from "@effect/vitest"
import { type AccessMessage, AgentEvent, DaemonEnvFile, type ProjectId, renderAgentEvent } from "@dream/domain"
import { Effect, Layer, Redacted, Schema } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { route } from "../src/http/Router.ts"
import { makeCloud } from "./support/Cloud.ts"

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const origin = "https://api.dream.test"
const claudeToken = `sk-ant-oat01-${"d".repeat(80)}`
const stripeKey = `sk_live_${"s".repeat(40)}`

/** A browser: one cookie jar, sending what a browser would (Origin on POSTs, cookies for the API's host). */
class Browser {
  readonly jar = new Map<string, string>()
  readonly cloud: Cloud
  constructor(cloud: Cloud) {
    this.cloud = cloud
  }

  request(
    path: string,
    init: { method?: string; form?: Record<string, string>; origin?: string | null; fetchSite?: string } = {}
  ) {
    const headers = new Headers()
    if (this.jar.size > 0) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "))
    const method = init.method ?? (init.form === undefined ? "GET" : "POST")
    if (method === "POST" && init.origin !== null) headers.set("origin", init.origin ?? origin)
    if (init.form !== undefined) headers.set("content-type", "application/x-www-form-urlencoded")
    if (init.fetchSite !== undefined) headers.set("sec-fetch-site", init.fetchSite)
    const raw = new Request(`${origin}${path}`, {
      method,
      headers,
      ...(init.form === undefined ? {} : { body: new URLSearchParams(init.form).toString() })
    })
    const jar = this.jar
    const cloud = this.cloud
    return Effect.gen(function* () {
      const response = yield* route(raw).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
        Effect.provide(Layer.succeedContext(cloud.workerContext))
      )
      const web = HttpServerResponse.toWeb(response)
      const cookie = web.headers.get("set-cookie")
      if (cookie !== null) {
        const [pair] = cookie.split(";")
        jar.set(pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1))
      }
      return {
        status: web.status,
        headers: web.headers,
        location: web.headers.get("location") ?? "",
        body: yield* Effect.promise(() => web.text())
      }
    })
  }

  /** Follows the emailed link: the landing page, then Continue. */
  open(url: string) {
    const self = this
    return Effect.gen(function* () {
      const link = new URL(url)
      const landing = yield* self.request(link.pathname + link.search)
      const opened = yield* self.request("/desktop/open", { form: { t: link.hash.slice(1) } })
      return { landing, opened }
    })
  }
}

const sandboxEnv = (cloud: Cloud, projectId: ProjectId) => {
  const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  const lines = sandbox.files.get(DaemonEnvFile)!.trim().split("\n")
  return Object.fromEntries(
    lines.map((line) => [line.slice(0, line.indexOf("=")), JSON.parse(line.slice(line.indexOf("=") + 1))])
  ) as Record<string, string>
}

/** Signs in, connects Claude, creates a project and its sandbox; returns dreamd's client. */
const setup = (cloud: Cloud, email = "ada@example.com") =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({ email, secret: Redacted.make("dev-secret") })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
    const link = yield* cloud.phone.CreateConnectLink({ provider: "claude" })
    yield* new Browser(cloud).request("/connect/claude", {
      form: { t: new URL(link.url).searchParams.get("t")!, token: claudeToken }
    })
    const project = yield* cloud.phone.CreateProject({ idea: "A shop for my prints." })
    yield* cloud.alarm(project.id)
    const dreamd = yield* cloud.sandbox(sandboxEnv(cloud, project.id).DREAM_PROJECT_TOKEN!)
    return { project, dreamd }
  })

const askStripe = (dreamd: Effect.Success<ReturnType<Cloud["sandbox"]>>) =>
  dreamd.RequestAccess({
    request: {
      _tag: "Key",
      service: "Stripe",
      host: "api.stripe.com",
      header: "Authorization",
      format: "Bearer {key}"
    },
    why: "Take payments",
    context: "Make a restricted key at [Stripe's API keys page](https://dashboard.stripe.com/apikeys)."
  })

const cardOf = (cloud: Cloud, projectId: ProjectId, messageId: string) =>
  Effect.map(cloud.phone.ListMessages({ projectId }), ({ messages }) =>
    messages.find((m): m is AccessMessage => m._tag === "Access" && m.id === messageId)
  )

/** The link in the latest email. */
const emailedLink = (cloud: Cloud) => /https:\/\/\S+\/desktop#[A-Za-z0-9]+/.exec(cloud.mail.sent.at(-1)!.text)![0]

describe("finishing access on a computer", () => {
  it.live("tells the phone whether this deployment sends email, so the row shows only when it works", () =>
    Effect.gen(function* () {
      const on = yield* makeCloud()
      yield* setup(on)
      assert.deepStrictEqual(yield* on.phone.GetFeatures(), { emailLinks: true })
      const off = yield* makeCloud({}, { noEmail: true })
      const { project, dreamd } = yield* setup(off)
      assert.deepStrictEqual(yield* off.phone.GetFeatures(), { emailLinks: false })
      const request = yield* askStripe(dreamd)
      const refused = yield* off.phone
        .EmailAccessLink({ projectId: project.id, messageId: request.id })
        .pipe(Effect.flip)
      assert.strictEqual(refused._tag, "UpstreamFailure")
      assert.isUndefined((yield* cardOf(off, project.id, request.id))?.desktop)
    })
  )

  it.live("emails a link that opens once, in one browser, and connects the key as the phone would", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const request = yield* askStripe(dreamd)
      assert.strictEqual(cloud.mail.sent.length, 0, "nothing is sent until they ask")

      const card = yield* cloud.phone.EmailAccessLink({ projectId: project.id, messageId: request.id })
      assert.strictEqual(card.state._tag, "Open")
      assert.strictEqual(card.desktop?.to, "ada@example.com")
      assert.isUndefined(card.desktop?.openedAt)
      assert.deepStrictEqual((yield* cardOf(cloud, project.id, request.id))?.desktop, card.desktop)

      // The email: to them, from Dream, saying what it's for, with a link whose token is in the fragment only.
      const mail = cloud.mail.sent[0]!
      assert.strictEqual(mail.to, "ada@example.com")
      assert.strictEqual(mail.from.email, "dream@mail.dream.test")
      assert.strictEqual(mail.subject, "Add your Stripe key")
      assert.include(mail.text, "works once, for 30 minutes")
      const url = emailedLink(cloud)
      assert.include(mail.html, `href="${url}"`)
      const link = new URL(url)
      assert.strictEqual(link.pathname, "/desktop")
      assert.strictEqual(link.search, "")
      const token = link.hash.slice(1)
      assert.lengthOf(token, 43)

      // Only a hash of it is stored.
      const rows = () => cloud.db.prepare("SELECT * FROM desktop_links").all() as Array<Record<string, unknown>>
      assert.notInclude(JSON.stringify(rows()), token)

      const laptop = new Browser(cloud)
      const { landing, opened } = yield* laptop.open(url)
      assert.strictEqual(landing.status, 200)
      assert.notInclude(landing.body, token)
      assert.include(landing.body, "Continue")
      assert.match(landing.headers.get("content-security-policy")!, /script-src 'nonce-[^']+'.*form-action 'self'/)
      assert.strictEqual(landing.headers.get("referrer-policy"), "same-origin")
      assert.strictEqual(opened.status, 303)
      const linkId = opened.location.replace("/desktop/", "")
      assert.match(linkId, /^dsk_[A-Za-z0-9]{22}$/)
      const cookie = opened.headers.get("set-cookie")!
      assert.match(cookie, /^__Host-dream-dsk_\w+=\w{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800$/)
      assert.notInclude(JSON.stringify(rows()), laptop.jar.values().next().value!)
      assert.isDefined(
        (yield* cardOf(cloud, project.id, request.id))?.desktop?.openedAt,
        "the card shows it was opened"
      )

      const form = yield* laptop.request(opened.location)
      assert.strictEqual(form.status, 200)
      assert.include(form.body, "Add your Stripe key")
      assert.include(form.body, "Take payments")
      assert.include(
        form.body,
        '<a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer">'
      )
      assert.include(form.body, 'type="password"')
      assert.include(form.body, "ada@example.com")

      // Forwarded on, or opened again elsewhere: it was used. Without the session, the page isn't there.
      const other = new Browser(cloud)
      const second = yield* other.open(url)
      assert.strictEqual(second.opened.status, 410)
      assert.include(second.opened.body, "already opened")
      assert.strictEqual(other.jar.size, 0)
      assert.strictEqual((yield* other.request(opened.location)).status, 404)
      assert.strictEqual((yield* other.request(opened.location, { form: { key: "sk_live_theirs" } })).status, 404)

      // The same browser following the email again goes back to its page.
      const again = yield* laptop.open(url)
      assert.strictEqual(again.opened.status, 303)
      assert.strictEqual(again.opened.location, opened.location)

      // A POST from anywhere but this page is refused, even with the cookie.
      const forged = yield* laptop.request(opened.location, { form: { key: stripeKey }, origin: "https://evil.test" })
      assert.strictEqual(forged.status, 403)
      const noOrigin = yield* laptop.request(opened.location, { form: { key: stripeKey }, origin: null })
      assert.strictEqual(noOrigin.status, 403)
      const nullCrossSite = yield* laptop.request(opened.location, {
        form: { key: stripeKey },
        origin: "null",
        fetchSite: "cross-site"
      })
      assert.strictEqual(nullCrossSite.status, 403)
      // A browser that sends `Origin: null` on its own page's post still says it's same-origin.
      const nullSameSite = yield* laptop.request(opened.location, {
        form: { key: "" },
        origin: "null",
        fetchSite: "same-origin"
      })
      assert.strictEqual(nullSameSite.status, 400)
      assert.include(nullSameSite.body, "Paste the key first.")

      const saved = yield* laptop.request(opened.location, { form: { key: `  ${stripeKey}\n` } })
      assert.strictEqual(saved.status, 200)
      assert.include(saved.body, "Saved")
      assert.notInclude(saved.body, stripeKey)

      // Connected the way the phone connects it: the card, the sandbox's egress rule, the agent's event.
      const connected = yield* cardOf(cloud, project.id, request.id)
      assert.strictEqual(connected?.state._tag, "Connected")
      const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === project.id)!
      assert.deepStrictEqual(sandbox.rules["api.stripe.com"], [
        { transform: { headers: { Authorization: `Bearer ${stripeKey}` } } }
      ])
      assert.notInclude(JSON.stringify(cloud.db.prepare("SELECT * FROM secrets").all()), stripeKey)
      yield* cloud.alarm(project.id)
      const event = cloud.world.delivered.at(-1)!.events[0]
      if (!Schema.is(AgentEvent)(event)) return yield* Effect.die("not an agent event")
      assert.include(renderAgentEvent(event), "Stripe")

      // Done means done: the page says so, and the link and its session do nothing more.
      const after = yield* laptop.request(opened.location, { form: { key: "sk_live_other" } })
      assert.include(after.body, "already finished")
      assert.include((yield* laptop.open(url)).opened.body, "already finished")
      assert.strictEqual(sandbox.rules["api.stripe.com"]?.[0]?.transform.headers.Authorization, `Bearer ${stripeKey}`)
      assert.notInclude(JSON.stringify(cloud.mail.sent), stripeKey)
    })
  )

  it.live("stops working when it expires, is replaced, or the request is declined", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const request = yield* askStripe(dreamd)
      const ref = { projectId: project.id, messageId: request.id }

      // Thirty minutes after sending, an unopened link is dead.
      yield* cloud.phone.EmailAccessLink(ref)
      const first = emailedLink(cloud)
      cloud.db.prepare("UPDATE desktop_links SET expires_at_ms = ?").run(Date.now() - 1)
      const late = yield* new Browser(cloud).open(first)
      assert.strictEqual(late.opened.status, 410)
      assert.include(late.opened.body, "expired")

      // Sending again replaces the older link.
      yield* cloud.phone.EmailAccessLink(ref)
      const second = emailedLink(cloud)
      yield* cloud.phone.EmailAccessLink(ref)
      const third = emailedLink(cloud)
      assert.include((yield* new Browser(cloud).open(second)).opened.body, "newer link")

      // A session ends too, and the open page with it.
      const laptop = new Browser(cloud)
      const { opened } = yield* laptop.open(third)
      cloud.db.prepare("UPDATE desktop_links SET session_expires_at_ms = ?").run(Date.now() - 1)
      const stale = yield* laptop.request(opened.location)
      assert.strictEqual(stale.status, 410)
      assert.include(stale.body, "expired")

      // Declined on the phone while the page is open: the page can't connect it.
      yield* cloud.phone.EmailAccessLink(ref)
      const fourth = new Browser(cloud)
      const page = yield* fourth.open(emailedLink(cloud))
      yield* cloud.phone.DeclineAccess(ref)
      const declined = yield* fourth.request(page.opened.location, { form: { key: stripeKey } })
      assert.include(declined.body, "You declined this request")
      assert.strictEqual((yield* cardOf(cloud, project.id, request.id))?.state._tag, "Declined")

      // And a declined request can't be emailed.
      const refused = yield* cloud.phone.EmailAccessLink(ref).pipe(Effect.flip)
      assert.strictEqual(refused._tag, "InvalidRequest")
    })
  )

  it.live("connects Google in the browser, and the callback finishes there", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const request = yield* dreamd.RequestAccess({
        request: { _tag: "Google", scopes: ["gmail.readonly"] },
        why: "Find the print orders in Gmail."
      })
      yield* cloud.phone.EmailAccessLink({ projectId: project.id, messageId: request.id })
      const laptop = new Browser(cloud)
      const { opened } = yield* laptop.open(emailedLink(cloud))
      const form = yield* laptop.request(opened.location)
      assert.include(form.body, "Continue with Google")

      const start = yield* laptop.request(`${opened.location}/sign-in`)
      assert.strictEqual(start.status, 302)
      const state = new URL(start.location).searchParams.get("state")!
      assert.match(state, /^dsk\.dsk_\w+\./)
      // Another browser can't start one.
      assert.strictEqual((yield* new Browser(cloud).request(`${opened.location}/sign-in`)).status, 404)

      const back = yield* laptop.request(`/oauth/google/callback?code=code-1&state=${state}`)
      assert.strictEqual(back.status, 200)
      assert.include(back.body, "Google is connected")
      assert.strictEqual((yield* cardOf(cloud, project.id, request.id))?.state._tag, "Connected")
      assert.include((yield* laptop.request(opened.location)).body, "already finished")
    })
  )

  it.live("shows a cancelled sign-in in the browser, with a way to try again", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const request = yield* dreamd.RequestAccess({
        request: { _tag: "Google", scopes: ["gmail.readonly"] },
        why: "Find the print orders in Gmail."
      })
      yield* cloud.phone.EmailAccessLink({ projectId: project.id, messageId: request.id })
      const laptop = new Browser(cloud)
      const { opened } = yield* laptop.open(emailedLink(cloud))
      const start = yield* laptop.request(`${opened.location}/sign-in`)
      const state = new URL(start.location).searchParams.get("state")!
      const back = yield* laptop.request(`/oauth/google/callback?error=access_denied&state=${state}`)
      assert.strictEqual(back.status, 400)
      assert.include(back.body, "It was cancelled.")
      assert.include(back.body, `href="${opened.location}"`)
      assert.strictEqual((yield* laptop.request(opened.location)).status, 200)
    })
  )

  it.live("sends only for them, a few times, and says when email fails", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const request = yield* askStripe(dreamd)
      const ref = { projectId: project.id, messageId: request.id }

      // Email failing: the card stays as it was, and the error names only the provider's code.
      cloud.mail.failWith = "E_RECIPIENT_SUPPRESSED"
      const failed = yield* cloud.phone.EmailAccessLink(ref).pipe(Effect.flip)
      assert.strictEqual(failed._tag, "UpstreamFailure")
      assert.include(failed.message, "E_RECIPIENT_SUPPRESSED")
      assert.notInclude(failed.message, "desktop#")
      assert.isUndefined((yield* cardOf(cloud, project.id, request.id))?.desktop)
      cloud.mail.failWith = undefined

      for (let i = 0; i < 4; i++) yield* cloud.phone.EmailAccessLink(ref)
      const limited = yield* cloud.phone.EmailAccessLink(ref).pipe(Effect.flip)
      assert.strictEqual(limited._tag, "InvalidRequest")
      assert.include(limited.message, "a few emails already")
      assert.lengthOf(cloud.mail.sent, 4)

      // Someone else can't send one for this request.
      const signedIn = yield* cloud.phone.DevSignIn({ email: "eve@example.com", secret: Redacted.make("dev-secret") })
      cloud.session.token = Redacted.value(signedIn.sessionToken)
      const stranger = yield* cloud.phone.EmailAccessLink(ref).pipe(Effect.flip)
      assert.strictEqual(stranger._tag, "NotFound")
      assert.lengthOf(cloud.mail.sent, 4)
    })
  )
})
