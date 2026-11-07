/**
 * The page a `CreateConnectLink` URL opens: one password field for the token
 * `claude setup-token` printed, posted back to the same path. No scripts at
 * all; the CSP allows only this page's own inline style (by nonce) and posting
 * the form to itself. The body is never logged and the token never echoed.
 */
import { ConnectLinkProvider, Routes } from "@dream/domain"
import { Effect, Option, Schema } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import { ConnectLinks, ConnectLinkUnusable } from "../connect/ConnectLinks.ts"
import { escape, page } from "./PageKit.ts"

const ConnectForm = Schema.Struct({
  t: Schema.String,
  token: Schema.RedactedFromValue(Schema.String)
})

const form = (provider: ConnectLinkProvider, ticket: string, error?: string) =>
  page(
    "Connect Claude",
    `<div class="mark">D</div><h1>Connect Claude</h1>` +
      `<p>Paste the token <code>claude setup-token</code> printed in your terminal.</p>` +
      (error === undefined ? "" : `<div class="error" role="alert">${escape(error)}</div>`) +
      `<form method="post" action="${Routes.connect(provider)}" autocomplete="off">` +
      `<input type="hidden" name="t" value="${escape(ticket)}">` +
      `<label for="token">Token from <code>claude setup-token</code></label>` +
      `<input id="token" name="token" type="password" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-oat01-…">` +
      `<button type="submit">Connect</button></form>` +
      `<p class="note">It's stored encrypted and never shown again.</p>`,
    error === undefined ? 200 : 400
  )

const unusable = (error: ConnectLinkUnusable) =>
  page(
    "Link not valid",
    `<div class="mark">!</div><h1>${error.reason === "used" ? "This link was already used" : error.reason === "expired" ? "This link expired" : "This link isn't valid"}</h1>` +
      `<p>Links work once, for 15 minutes. Ask Dream for a new one to connect Claude.</p>`,
    error.reason === "invalid" ? 404 : 410
  )

const connected = () =>
  page(
    "Claude connected",
    `<div class="mark">✓</div><h1>Claude is connected</h1>` +
      `<p>Your token is stored encrypted. You can close this page and go back to Dream.</p>`
  )

/** `GET Routes.connect(provider)?t=…` */
export const showConnectPage = (provider: ConnectLinkProvider, ticket: string | null) =>
  Effect.gen(function* () {
    if (ticket === null) return unusable(new ConnectLinkUnusable({ reason: "invalid" }))
    const links = yield* ConnectLinks
    return yield* links.check(provider, ticket).pipe(
      Effect.as(form(provider, ticket)),
      Effect.catchTag("ConnectLinkUnusable", (error) => Effect.succeed(unusable(error)))
    )
  })

/** `POST Routes.connect(provider)` with the form's `t` and `token`. */
export const submitConnectPage = (provider: ConnectLinkProvider) =>
  Effect.gen(function* () {
    const links = yield* ConnectLinks
    const body = yield* HttpServerRequest.schemaBodyUrlParams(ConnectForm).pipe(Effect.option)
    if (Option.isNone(body)) return unusable(new ConnectLinkUnusable({ reason: "invalid" }))
    const { t, token } = body.value
    return yield* links.redeem(provider, t, token).pipe(
      Effect.map(connected),
      Effect.catchTags({
        ConnectLinkUnusable: (error) => Effect.succeed(unusable(error)),
        InvalidRequest: (error) => Effect.succeed(form(provider, t, error.message))
      })
    )
  })

/** The provider a `/connect/:provider` path names, if it's one these pages serve. */
export const connectProvider = (segment: string) => Schema.decodeUnknownOption(ConnectLinkProvider)(segment)
