/**
 * The two public pages on the API host: `/` (what Dream is) and `/privacy`.
 * Google's consent screen links to both. Static HTML with one inline style and
 * no scripts or external assets, so the CSP allows nothing else.
 */
import * as HttpServerResponse from "effect/http/HttpServerResponse"

const contact = "omerfarukpiano@gmail.com"
const updated = "November 5, 2026"

const style = `
:root{color-scheme:light dark;--bg:#FAFAF7;--fg:#16161A;--muted:#5C5C66;--line:rgba(0,0,0,.1);--accent:#B86A00}
@media (prefers-color-scheme:dark){:root{--bg:#0A0A0C;--fg:#F5F5F7;--muted:rgba(245,245,247,.64);--line:rgba(255,255,255,.1);--accent:#FFB35C}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:17px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:640px;margin:0 auto;padding:48px 22px 64px}
h1{margin:0 0 12px;font-size:30px;line-height:1.2;letter-spacing:-.02em}
h2{margin:36px 0 8px;font-size:19px;letter-spacing:-.01em}
p,li{color:var(--muted)}
p{margin:0 0 14px}
ul{margin:0 0 14px;padding-left:20px}
li{margin:0 0 6px}
strong{color:var(--fg);font-weight:600}
a{color:var(--accent)}
.lede{font-size:19px;color:var(--fg)}
.mark{display:inline-flex;width:44px;height:44px;margin-bottom:20px;border-radius:12px;align-items:center;
  justify-content:center;background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent);font-weight:700}
footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);font-size:14px;color:var(--muted)}
`

const page = (title: string, description: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="description" content="${description}">` +
  `<title>${title}</title><style>${style}</style></head>` +
  `<body><main>${body}<footer><a href="/">Dream</a> · <a href="/privacy">Privacy policy</a> · ` +
  `<a href="mailto:${contact}">${contact}</a></footer></main></body></html>`

const home = page(
  "Dream",
  "Describe an idea on your iPhone, and an AI agent builds it for you.",
  `<div class="mark">D</div><h1>Dream</h1>` +
    `<p class="lede">Dream is an iPhone app where you describe an idea and an AI agent builds it for you, ` +
    `over hours or weeks.</p>` +
    `<p>Each project gets its own cloud computer, where the agent writes the code, runs it and publishes it at its ` +
    `own web address. It works with the Claude or ChatGPT subscription you connect, and keeps you posted on your ` +
    `phone: a status card, a chat, and questions when it needs a decision from you.</p>` +
    `<p>When a project needs one of your accounts, such as Gmail or Google Calendar, the agent asks first, and ` +
    `nothing is connected unless you approve it. Dream is in a small private beta, by invitation.</p>` +
    `<p><a href="/privacy">How Dream handles your data</a></p>`
)

const privacy = page(
  "Privacy policy · Dream",
  "What Dream collects, how it stores your credentials, and how it uses Google user data.",
  `<h1>Privacy policy</h1>` +
    `<p>Last updated ${updated}. This policy covers the Dream iPhone app and the service behind it at ` +
    `dream.omer.build. Questions or requests: <a href="mailto:${contact}">${contact}</a>.</p>` +
    //
    `<h2>What Dream collects</h2><ul>` +
    `<li><strong>Your account.</strong> When you sign in with Google: your email address, your name and your ` +
    `Google account id. Dream also keeps your time zone.</li>` +
    `<li><strong>Your projects.</strong> The ideas you describe, the messages between you and the agent (text, ` +
    `answers to its questions, screenshots and recordings), the project's status card and schedule, and the code ` +
    `and files the agent creates in the project's cloud computer.</li>` +
    `<li><strong>Your devices.</strong> The push notification and Live Activity tokens Apple gives the app, so ` +
    `Dream can notify you.</li>` +
    `<li><strong>Connected credentials.</strong> The Claude or ChatGPT sign-in you connect, and any account access ` +
    `you approve for a project: Google sign-in tokens, other services' sign-in tokens, API keys you paste, and App ` +
    `Store Connect keys.</li>` +
    `<li><strong>Usage.</strong> How many minutes each project used its cloud computer, browser and Mac, and your ` +
    `subscription's usage limits as the model provider reports them.</li></ul>` +
    `<p>Dream has no ads, no analytics trackers and no third-party cookies.</p>` +
    //
    `<h2>How credentials are stored</h2>` +
    `<p>Every credential is encrypted with AES-GCM before it is stored in Dream's database. The encryption key ` +
    `exists only as a secret of Dream's server, which is the only place credentials are decrypted. The code the ` +
    `agent writes never receives your tokens: its computer holds only a placeholder, and the server has the real ` +
    `value added to the outgoing request at the network edge, only for requests to that service's own addresses ` +
    `(for Google, its API hosts such as gmail.googleapis.com and www.googleapis.com). The one exception is a key ` +
    `that can't be sent that way (a bot token, an email password): if you choose to provide one, the app warns you ` +
    `that it will be written into that one project's computer as a file.</p>` +
    //
    `<h2>Google user data</h2>` +
    `<p>Signing in with Google gives Dream your email address, name and Google account id, used only to identify ` +
    `you and check that you were invited.</p>` +
    `<p>Beyond that, an agent can reach your Google data only after it asks and you approve. It names the access ` +
    `it wants (for example Gmail read-only, or Calendar) and why; you then grant exactly those permissions on ` +
    `Google's own consent screen. With your approval, the code in that project's computer can call the Google APIs ` +
    `those permissions cover, such as Gmail, Calendar, Drive, Sheets, Docs and Contacts, to build and run the thing ` +
    `you asked for. Whatever it reads is used for that project, and it is processed by the AI model of the Claude ` +
    `or ChatGPT account you connected, under that account's own terms with Anthropic or OpenAI.</p>` +
    `<p>Dream's use and transfer to any other app of information received from Google APIs will adhere to the ` +
    `<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data ` +
    `Policy</a>, including the Limited Use requirements. In particular:</p><ul>` +
    `<li>Google user data is used only to provide the features you asked for in Dream.</li>` +
    `<li>It is not sold, and it is never used for advertising, including retargeting or personalized ads.</li>` +
    `<li>Dream does not use it to develop, improve or train AI or machine learning models, and does not give it to ` +
    `anyone for that purpose.</li>` +
    `<li>It is transferred to others only as needed to provide your project (the services listed below), to ` +
    `comply with the law, or as part of a merger or sale with the same protections.</li>` +
    `<li>People don't read it unless you ask us to (for example to fix a problem), it's needed for security or ` +
    `abuse investigations, or the law requires it.</li></ul>` +
    //
    `<h2>Services Dream relies on</h2>` +
    `<p>Dream runs on Cloudflare (its server, database and media storage), E2B (each project's cloud computer, ` +
    `including the network edge that adds your credentials to requests), Anthropic or OpenAI (the AI model, through ` +
    `the account you connect), Browserbase (a cloud browser, when the agent needs one), Namespace (a cloud Mac, when ` +
    `a project needs one) and Apple (push notifications). Each receives only what it needs to do that job.</p>` +
    //
    `<h2>Removing access and deleting data</h2><ul>` +
    `<li><strong>A connection:</strong> disconnect it in the app's Settings. Dream revokes it with the provider when ` +
    `the provider supports that (Google does), deletes the stored credential, and removes it from all of your ` +
    `projects. You can also remove Dream's access at any time from ` +
    `<a href="https://myaccount.google.com/permissions">your Google account's permissions page</a>.</li>` +
    `<li><strong>Your Claude or ChatGPT connection:</strong> disconnect it in Settings, and Dream deletes it.</li>` +
    `<li><strong>Your account or a project:</strong> email <a href="mailto:${contact}">${contact}</a> from the ` +
    `address you sign in with. We delete the project's cloud computer, messages, media and records, or your whole ` +
    `account with every project and credential, within 30 days, and confirm by email.</li></ul>` +
    //
    `<h2>Children</h2><p>Dream is not meant for children under 13 and doesn't knowingly collect their data.</p>` +
    `<h2>Changes</h2><p>If this policy changes, the date at the top changes too.</p>`
)

const respond = (html: string) =>
  HttpServerResponse.text(html, {
    contentType: "text/html; charset=utf-8",
    headers: {
      "cache-control": "public, max-age=300",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  })

/** `GET /` on the API host. */
export const homePage = () => respond(home)

/** `GET /privacy` on the API host. */
export const privacyPage = () => respond(privacy)
