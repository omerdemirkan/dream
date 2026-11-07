/**
 * The look of the Worker's own pages (the token page, the desktop access pages): Deck v3's dark card, one column,
 * no third-party anything. The CSP allows only this page's inline style and, if it has one, its inline script (both
 * by nonce), and posting forms to itself.
 */
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { randomToken } from "../lib/Ids.ts"

export const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)

export const style = `
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

/** Built per request: the CSP nonce is random, and workerd forbids randomness at module scope. */
export const page = (
  title: string,
  body: string,
  status = 200,
  options: {
    readonly script?: string | undefined
    readonly css?: string | undefined
    readonly headers?: Record<string, string> | undefined
  } = {}
) => {
  const nonce = randomToken(22)
  return HttpServerResponse.text(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
      `<title>${escape(title)} · Dream</title><style nonce="${nonce}">${style}${options.css ?? ""}</style></head>` +
      `<body><main>${body}</main>` +
      (options.script === undefined ? "" : `<script nonce="${nonce}">${options.script}</script>`) +
      `</body></html>`,
    {
      status,
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
        "content-security-policy":
          `default-src 'none'; style-src 'nonce-${nonce}'; ` +
          (options.script === undefined ? "" : `script-src 'nonce-${nonce}'; `) +
          `form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        ...options.headers
      }
    }
  )
}
