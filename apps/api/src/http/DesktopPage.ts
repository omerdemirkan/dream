/**
 * The pages an `EmailAccessLink` email opens on a computer (src/desktop/DesktopAccess.ts has the rules):
 *
 * - `GET /desktop#<token>`: a page that says what's next, and a Continue button. Its script takes the token from
 *   the fragment (which no server sees) into the form and out of the address bar.
 * - `POST /desktop/open`: uses the link up, sets this browser's session cookie, and redirects to the request.
 * - `GET /desktop/<link>`: the request, with the same choices the card has (paste a key, the App Store Connect
 *   key's three parts, or a sign-in). `POST` submits a key; `GET /desktop/<link>/sign-in` starts a sign-in.
 *
 * POSTs must come from these pages (`Origin`), the session cookie is SameSite=Strict, and nothing submitted is
 * logged or echoed back.
 */
import {
  type AccessMessage,
  accessHeading,
  accessService,
  InvalidRequest,
  NotFound,
  Routes,
  UpstreamFailure
} from "@dream/domain"
import { Duration, Effect, Option, Redacted, Schema } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { ApiConfig } from "../Config.ts"
import { Users } from "../db/Users.ts"
import {
  DesktopAccess,
  DesktopLinkUnusable,
  type DesktopSession,
  LinkLifetime,
  SessionLifetime,
  sessionCookie
} from "../desktop/DesktopAccess.ts"
import { escape, page } from "./PageKit.ts"

const css = `
main{max-width:520px}
.eyebrow{margin:0 0 10px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#FFB35C}
.project{margin:0 0 4px;font-size:13px;color:rgba(245,245,247,.5)}
.context{margin:0 0 18px;padding:12px 14px;border-radius:12px;background:#1D1D21;color:rgba(245,245,247,.8);font-size:15px}
.context p{margin:0 0 8px;color:inherit}.context p:last-child{margin:0}
a{color:#FFB35C}
.field{margin-top:14px}
textarea{width:100%;min-height:150px;padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,.15);background:#1D1D21;
  color:#F5F5F7;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
textarea:focus{outline:none;border-color:rgba(255,179,92,.6)}
.file{display:block;margin-top:8px;font-size:13px;color:rgba(245,245,247,.5)}
.file input{width:auto;padding:0;border:0;background:none;font:inherit;color:inherit}
.file input::file-selector-button{margin-right:8px;padding:6px 12px;border:0;border-radius:999px;background:#28282D;
  color:#F5F5F7;font:inherit;font-weight:600;cursor:pointer}
.button{display:block;width:100%;margin-top:16px;padding:14px;border-radius:12px;background:#FFB35C;color:#1B1204;
  font-weight:650;text-align:center;text-decoration:none}
.warn{margin:14px 0 0;padding:10px 12px;border-radius:10px;background:rgba(255,179,92,.08);font-size:13px;color:rgba(245,245,247,.8)}
.account{margin:18px 0 0;padding-top:14px;border-top:1px solid rgba(255,255,255,.08);font-size:13px;color:rgba(245,245,247,.4)}
@media (min-width:700px){body{font-size:17px}main{max-width:560px;padding:40px 40px 34px}h1{font-size:28px}}
`

/**
 * Every desktop page: `same-origin` referrers, so a browser names this page as the origin of its own form posts
 * (with `no-referrer` it sends `Origin: null`) and still sends nothing to other sites, such as a context link.
 */
const desktopPage = (...[title, body, status, options]: Parameters<typeof page>) =>
  page(title, body, status, { ...options, headers: { ...options?.headers, "referrer-policy": "same-origin" } })

/** A key's form fields: the ids and names the Worker reads back. */
const KeyForm = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String) })
const AppleForm = Schema.Struct({
  issuerId: Schema.String,
  keyId: Schema.String,
  privateKey: Schema.RedactedFromValue(Schema.String)
})
const OpenForm = Schema.Struct({ t: Schema.RedactedFromValue(Schema.String) })

/**
 * The agent's `context`, in the little markdown it uses: paragraphs, **bold**, `code` and https links. Everything
 * else is text.
 */
export const contextHtml = (markdown: string): string =>
  markdown
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => {
      let html = escape(paragraph.trim()).replace(/\n/g, "<br>")
      html = html.replace(/`([^`]+)`/g, "<code>$1</code>")
      html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      html = html.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      html = html.replace(
        /\[([^\]]+)\]\((https:\/\/[^)\s"<>]+)\)/g,
        (_, text: string, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
      )
      return `<p>${html}</p>`
    })
    .join("")

const minutes = (duration: Duration.Duration) => Duration.toMinutes(duration)

const notice = (title: string, heading: string, text: string, status: number) =>
  desktopPage(title, `<div class="mark">!</div><h1>${escape(heading)}</h1><p>${escape(text)}</p>`, status, { css })

const sendAgain = "Send a new one from the request in Dream on your phone."

/** What a dead link or session says. Every message points back to the phone, where a new link comes from. */
const unusable = (error: DesktopLinkUnusable) => {
  switch (error.reason) {
    case "invalid":
      return notice(
        "Link not valid",
        "This link isn’t valid",
        `Open the newest email from Dream, or ${sendAgain.toLowerCase()}`,
        404
      )
    case "expired":
      return notice(
        "Link expired",
        "This link expired",
        `Links work for ${minutes(LinkLifetime)} minutes, and a page stays open for ${minutes(SessionLifetime)}. ${sendAgain}`,
        410
      )
    case "used":
      return notice(
        "Link already used",
        "This link was already opened",
        `Each link opens in one browser, once. If that wasn’t you, it can’t be used again. ${sendAgain}`,
        410
      )
    case "replaced":
      return notice(
        "Link replaced",
        "There’s a newer link",
        "You sent another email for this request. Open the newest one.",
        410
      )
    case "finished":
      return done("It’s done", "This request was already finished. You can close this page.")
    case "closed": {
      const state = error.message?.state._tag
      return state === "Connected"
        ? done("It’s connected", "This request was already connected. You can close this page.")
        : notice(
            "Not needed",
            state === "Declined" ? "You declined this request" : "This isn’t needed anymore",
            state === "Declined"
              ? "To connect it after all, open it in Dream on your phone."
              : "You can close this page.",
            410
          )
    }
  }
}

const done = (heading: string, text: string) =>
  desktopPage("Done", `<div class="mark">✓</div><h1>${escape(heading)}</h1><p>${escape(text)}</p>`, 200, { css })

const connected = (message: AccessMessage) =>
  done(
    message.request._tag === "Key" || message.request._tag === "File" || message.request._tag === "Apple"
      ? "Saved"
      : `${accessService(message.request)} is connected`,
    "It’s stored encrypted, and your phone shows it’s connected. You can close this page."
  )

/** The request's page in the browser holding its session, with an error from a submission if there was one. */
const requestPage = (session: DesktopSession, account: string | undefined, error?: string) => {
  const { message, link } = session
  const request = message.request
  const heading = accessHeading(message)
  const service = accessService(request)
  const action = Routes.desktopAccess(link.id)
  const intro =
    `<p class="eyebrow">Access</p>` +
    `<h1>${escape(heading.title)}</h1>` +
    (heading.reason === undefined ? "" : `<p>${escape(heading.reason)}</p>`) +
    (message.context === undefined ? "" : `<div class="context">${contextHtml(message.context)}</div>`) +
    (error === undefined ? "" : `<div class="error" role="alert">${escape(error)}</div>`)
  const stored = `<p class="note">It’s stored encrypted and never shown again.</p>`
  let body: string
  let script: string | undefined
  switch (request._tag) {
    case "Key":
    case "File":
      body =
        `<form method="post" action="${action}" autocomplete="off">` +
        `<label for="key">${escape(service)} key</label>` +
        `<input id="key" name="key" type="password" required autofocus autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste it here">` +
        `<button type="submit">${request._tag === "File" ? "Save" : "Save to vault"}</button></form>` +
        (request._tag === "File"
          ? `<p class="warn">Last resort: the key will live on this project’s computer, where any code running there can read it.</p>`
          : `<p class="note">Dream adds it to requests to ${escape(request.host)}. It’s stored encrypted and never shown again.</p>`)
      break
    case "Apple":
      body =
        `<form method="post" action="${action}" autocomplete="off">` +
        `<label for="issuerId">Issuer ID</label>` +
        `<input id="issuerId" name="issuerId" required autofocus autocomplete="off" spellcheck="false" placeholder="57246542-96fe-1a63-e053-0824d011072a">` +
        `<div class="field"><label for="keyId">Key ID</label>` +
        `<input id="keyId" name="keyId" required autocomplete="off" spellcheck="false" placeholder="2X9R4HXF34"></div>` +
        `<div class="field"><label for="privateKey">Private key (.p8)</label>` +
        `<textarea id="privateKey" name="privateKey" required spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----"></textarea>` +
        `<label class="file">Or choose the AuthKey file: <input id="p8" type="file" accept=".p8"></label></div>` +
        `<button type="submit">Save</button></form>${stored}`
      // Reads the chosen .p8 into the field, in this page; the file goes nowhere else.
      script =
        `document.getElementById("p8").addEventListener("change",function(e){var f=e.target.files&&e.target.files[0];` +
        `if(!f)return;f.text().then(function(t){document.getElementById("privateKey").value=t.trim()})})`
      break
    case "Google":
    case "OAuth":
      body =
        `<a class="button" href="${Routes.desktopSignIn(link.id)}">Continue with ${escape(request._tag === "Google" ? "Google" : service)}</a>` +
        `<p class="note">You’ll sign in and approve what it asks for. Dream keeps the sign-in fresh.</p>`
      break
    case "Notifications":
      body = `<p>Open this one in Dream on your phone.</p>`
      break
  }
  const footer = account === undefined ? "" : `<p class="account">For ${escape(account)}’s Dream</p>`
  return desktopPage(heading.title, intro + body + footer, error === undefined ? 200 : 400, { css, script })
}

/** POSTs must come from these pages. */
const sameOrigin = Effect.gen(function* () {
  const config = yield* ApiConfig
  const request = yield* HttpServerRequest.HttpServerRequest
  const origin = request.headers.origin
  // Browsers send the page's origin on same-origin form posts (the pages' referrer policy allows it); one that
  // sends `null` or none still says where the post came from in Sec-Fetch-Site.
  if (origin !== undefined && origin !== "null") return origin === config.apiUrl
  return request.headers["sec-fetch-site"] === "same-origin"
})

const forbidden = () =>
  notice("Not allowed", "That didn’t come from this page", "Open the link from your email again.", 403)

/** `GET Routes.desktop` */
export const showDesktopLanding = Effect.sync(() =>
  desktopPage(
    "Finish on this computer",
    `<div class="mark">D</div><h1>Finish on this computer</h1>` +
      `<p id="lead">Continue to see the request from Dream and finish it here.</p>` +
      `<form id="open" method="post" action="${Routes.desktopOpen}"><input type="hidden" name="t" id="t">` +
      `<button type="submit" id="go" disabled>Continue</button></form>` +
      `<p class="note">The link works once, in one browser.</p>`,
    200,
    {
      css,
      script:
        `var t=location.hash.slice(1);history.replaceState(null,"",location.pathname);` +
        `if(/^[A-Za-z0-9]{43}$/.test(t)){document.getElementById("t").value=t;document.getElementById("go").disabled=false}` +
        `else{document.getElementById("lead").textContent="This link is incomplete. Open it straight from the email, or send a new one from Dream on your phone.";` +
        `document.getElementById("open").remove()}`
    }
  )
)

/** `POST Routes.desktopOpen` with the form's `t`. */
export const openDesktopLink = Effect.gen(function* () {
  if (!(yield* sameOrigin)) return forbidden()
  const request = yield* HttpServerRequest.HttpServerRequest
  const body = yield* HttpServerRequest.schemaBodyUrlParams(OpenForm).pipe(Effect.option)
  if (Option.isNone(body)) return unusable(new DesktopLinkUnusable({ reason: "invalid" }))
  const desktop = yield* DesktopAccess
  return yield* desktop.open(body.value.t, request.cookies).pipe(
    Effect.map(({ linkId, session }) =>
      HttpServerResponse.empty({
        status: 303,
        headers: {
          location: Routes.desktopAccess(linkId),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          ...(session === undefined
            ? {}
            : {
                "set-cookie": `${sessionCookie(linkId)}=${Redacted.value(session)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Duration.toSeconds(SessionLifetime)}`
              })
        }
      })
    ),
    Effect.catchTag("DesktopLinkUnusable", (error) => Effect.succeed(unusable(error)))
  )
})

/** The person whose Dream it is, for the page's footer, so a forwarded link reads as someone else's. */
const accountOf = (session: DesktopSession) =>
  Effect.gen(function* () {
    const users = yield* Users
    return Option.getOrUndefined(Option.map(yield* users.find(session.link.user_id), (user) => user.email))
  })

const withSession = <A, E, R>(linkId: string, use: (session: DesktopSession) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const desktop = yield* DesktopAccess
    return yield* desktop.session(linkId, request.cookies).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(unusable(error)),
        onSuccess: use
      })
    )
  })

/** `GET Routes.desktopAccess(link)` */
export const showDesktopAccess = (linkId: string) =>
  withSession(linkId, (session) => Effect.map(accountOf(session), (account) => requestPage(session, account)))

/** `POST Routes.desktopAccess(link)`: a key, or the App Store Connect key's parts. */
export const submitDesktopAccess = (linkId: string) =>
  Effect.gen(function* () {
    if (!(yield* sameOrigin)) return forbidden()
    const desktop = yield* DesktopAccess
    return yield* withSession(linkId, (session) =>
      Effect.gen(function* () {
        const account = yield* accountOf(session)
        const failed = (error: NotFound | InvalidRequest | UpstreamFailure) =>
          Effect.succeed(
            requestPage(
              session,
              account,
              error instanceof InvalidRequest
                ? error.message
                : error instanceof UpstreamFailure
                  ? `Couldn’t save it: ${error.message}. Try again in a moment.`
                  : "This request is gone."
            )
          )
        const request = session.message.request
        if (request._tag === "Key" || request._tag === "File") {
          const form = yield* HttpServerRequest.schemaBodyUrlParams(KeyForm).pipe(Effect.option)
          if (Option.isNone(form) || Redacted.value(form.value.key).trim().length === 0) {
            return requestPage(session, account, "Paste the key first.")
          }
          return yield* desktop.submitKey(session, form.value.key).pipe(Effect.map(connected), Effect.catch(failed))
        }
        if (request._tag === "Apple") {
          const form = yield* HttpServerRequest.schemaBodyUrlParams(AppleForm).pipe(Effect.option)
          if (
            Option.isNone(form) ||
            form.value.issuerId.trim() === "" ||
            form.value.keyId.trim() === "" ||
            Redacted.value(form.value.privateKey).trim() === ""
          ) {
            return requestPage(session, account, "Fill in all three: the issuer ID, the key ID and the .p8 key.")
          }
          return yield* desktop.submitApple(session, form.value).pipe(Effect.map(connected), Effect.catch(failed))
        }
        return requestPage(session, account)
      })
    )
  })

/** `GET Routes.desktopSignIn(link)`: off to the provider, which comes back to the OAuth callback. */
export const startDesktopSignIn = (linkId: string) =>
  Effect.gen(function* () {
    const desktop = yield* DesktopAccess
    return yield* withSession(linkId, (session) =>
      desktop.signIn(session).pipe(
        Effect.map((url) =>
          HttpServerResponse.redirect(url, {
            status: 302,
            headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" }
          })
        ),
        Effect.catch((error) =>
          Effect.map(accountOf(session), (account) =>
            requestPage(
              session,
              account,
              error instanceof UpstreamFailure ? `Sign-in isn’t available: ${error.message}.` : error.message
            )
          )
        )
      )
    )
  })

/** Where an OAuth callback for a desktop sign-in lands. */
export const desktopSignInResult = (
  linkId: string,
  result: { readonly service: string } & ({ readonly ok: true } | { readonly ok: false; readonly error: string })
) =>
  Effect.gen(function* () {
    if (result.ok) {
      const desktop = yield* DesktopAccess
      yield* desktop.signedIn(linkId)
      return done(`${result.service} is connected`, "Your phone shows it’s connected. You can close this page.")
    }
    return desktopPage(
      "Sign-in didn’t finish",
      `<div class="mark">!</div><h1>The sign-in didn’t finish</h1>` +
        `<p>${escape(result.error === "cancelled" ? "It was cancelled." : `${result.service} said: ${result.error}.`)}</p>` +
        `<a class="button" href="${Routes.desktopAccess(linkId)}">Try again</a>`,
      400,
      { css }
    )
  })
