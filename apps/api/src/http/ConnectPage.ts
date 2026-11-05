/**
 * The page a `CreateConnectLink` URL opens: one password field for the token
 * `claude setup-token` printed, posted back to the same path. No scripts at
 * all; the CSP allows only this page's own inline style (by nonce) and posting
 * the form to itself. The body is never logged and the token never echoed.
 */
import { ConnectLinkProvider, Routes } from "@dream/domain"
import { Effect, Option, Schema } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { ConnectLinks, ConnectLinkUnusable } from "../connect/ConnectLinks.ts"
import { randomToken } from "../lib/Ids.ts"

const ConnectForm = Schema.Struct({
  t: Schema.String,
  token: Schema.RedactedFromValue(Schema.String)
})

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)

const style = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  background:#0A0A0C;color:#F5F5F7;font:16px/1.4 Inter,-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased}
main{width:100%;max-width:420px;background:#141417;border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:28px 24px}
h1{margin:0 0 8px;font-size:22px;font-weight:650;letter-spacing:-.01em}
p{margin:0 0 16px;color:rgba(245,245,247,.64)}
label{display:block;margin:0 0 8px;font-size:14px;font-weight:600}
code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;color:#F5F5F7}
input{width:100%;padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,.15);background:#1D1D21;
  color:#F5F5F7;font:15px ui-monospace,SFMono-Regular,Menlo,monospace}
input:focus{outline:none;border-color:rgba(255,179,92,.6)}
button{width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;background:#FFB35C;color:#1B1204;
  font:inherit;font-weight:650;cursor:pointer}
.note{margin:14px 0 0;font-size:13px;color:rgba(245,245,247,.40)}
.error{margin:0 0 16px;padding:10px 12px;border-radius:10px;background:rgba(255,179,92,.12);
  border:1px solid rgba(255,179,92,.34);color:#FFB35C;font-size:14px}
.mark{display:inline-flex;width:40px;height:40px;margin-bottom:14px;border-radius:12px;align-items:center;
  justify-content:center;background:rgba(255,179,92,.12);color:#FFB35C;font-weight:700}
`

const page = (title: string, body: string, status = 200) => {
  const nonce = randomToken(22)
  return HttpServerResponse.text(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
      `<title>${escape(title)} · Dream</title><style nonce="${nonce}">${style}</style></head>` +
      `<body><main>${body}</main></body></html>`,
    {
      status,
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY"
      }
    }
  )
}

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

const connected = page(
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
      Effect.as(connected),
      Effect.catchTags({
        ConnectLinkUnusable: (error) => Effect.succeed(unusable(error)),
        InvalidRequest: (error) => Effect.succeed(form(provider, t, error.message))
      })
    )
  })

/** The provider a `/connect/:provider` path names, if it's one these pages serve. */
export const connectProvider = (segment: string) => Schema.decodeUnknownOption(ConnectLinkProvider)(segment)
