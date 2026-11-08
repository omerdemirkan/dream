# OAuth providers: registering Dream's app with each

Agents can ask a person to connect a service that signs in with OAuth (`dream access oauth spotify`). The person
taps **Continue with Spotify** on the card, consents on Spotify's page, and is done for all their projects. Dream
holds the refresh token and adds a current access token to the sandbox's HTTPS requests to that provider's API hosts.

For that to work, each provider needs **one OAuth app registered by you, for Dream**, and its client id and secret
set as Worker secrets. Until both secrets are set, the provider is "not set up": an agent that asks for it is told so
straight away, and no card reaches anyone. Nothing else needs configuring, and no deploy is needed after setting
secrets (they're read on each request).

The providers below ship configured in `apps/api/src/integrations/OAuth.ts`. Portals change their wording often;
the field names here were right as of November 2026.

## The common parts

**Redirect URI.** Every provider redirects to the API host, one path per provider:

```
https://dream.omer.build/oauth/<provider>/callback
```

e.g. `https://dream.omer.build/oauth/spotify/callback`. Register exactly that (https, no trailing slash). If the API
host ever changes (`DREAM_API_HOST`), every provider's redirect URI has to change with it.

**Worker secrets.** Two per provider, named after its id:

| Provider | Client id secret | Client secret secret |
| --- | --- | --- |
| Spotify | `OAUTH_SPOTIFY_CLIENT_ID` | `OAUTH_SPOTIFY_CLIENT_SECRET` |
| GitHub | `OAUTH_GITHUB_CLIENT_ID` | `OAUTH_GITHUB_CLIENT_SECRET` |
| Strava | `OAUTH_STRAVA_CLIENT_ID` | `OAUTH_STRAVA_CLIENT_SECRET` |
| Dropbox | `OAUTH_DROPBOX_CLIENT_ID` | `OAUTH_DROPBOX_CLIENT_SECRET` |
| Slack | `OAUTH_SLACK_CLIENT_ID` | `OAUTH_SLACK_CLIENT_SECRET` |
| Notion | `OAUTH_NOTION_CLIENT_ID` | `OAUTH_NOTION_CLIENT_SECRET` |
| Microsoft | `OAUTH_MICROSOFT_CLIENT_ID` | `OAUTH_MICROSOFT_CLIENT_SECRET` |
| Oura | `OAUTH_OURA_CLIENT_ID` | `OAUTH_OURA_CLIENT_SECRET` |

Set them as **secrets** (not plain variables, which a deploy wipes) on the `dream-api` Worker, either way:

- Cloudflare dashboard → **Workers & Pages** → **dream-api** → **Settings** → **Variables and Secrets** → **Add** →
  Type **Secret**, the name above, paste the value → **Deploy**.
- Or from the repo root, with the value on the clipboard (it never reaches the screen or shell history):

  ```sh
  pbpaste | node infra/scripts/set-secret.ts OAUTH_SPOTIFY_CLIENT_SECRET
  ```

  It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the root `.env`, like the other scripts in
  `infra/scripts`.

**Checking one.** In any project, have the agent (or you, from the sandbox) run
`dream access oauth <provider> --why "test"`. "isn't set up on this deployment" means a secret is missing or misnamed.
If the card appears but the sign-in comes back with "refused Dream's client id or secret", the secret value is wrong.
Disconnect the test connection in Settings afterwards.

**Scopes.** Agents ask for scopes per request, in the provider's own names, so you don't pick them at registration
except where noted (Dropbox, Slack). Each provider has a small default for when the agent names none.

---

## Spotify

1. Go to <https://developer.spotify.com/dashboard>, log in with the Spotify account that will own the app (it needs
   **Premium**), and click **Create app**.
2. **App name** `Dream`, any **App description**. **Redirect URIs**: add
   `https://dream.omer.build/oauth/spotify/callback`. Under **Which API/SDKs are you planning to use?** tick
   **Web API**. Accept the terms and **Save**.
3. Open the app → **Settings** → **Basic Information**: copy **Client ID** into `OAUTH_SPOTIFY_CLIENT_ID`, click
   **View client secret** and copy it into `OAUTH_SPOTIFY_CLIENT_SECRET`.
4. **User Management** (in the app's settings): add each person who'll connect Spotify, by name and the email of
   their Spotify account. Only allowlisted accounts can sign in.

Quirks: since February 2026 a development-mode app allows **five** allowlisted users, and the owner needs Premium.
Extended quota (no allowlist) is only granted to registered businesses with 250k monthly users, so plan on the
allowlist. Someone not on it gets an error from Spotify after consenting. Dream uses PKCE plus the client secret.
Access tokens last an hour and Dream refreshes them; Spotify sometimes rotates the refresh token, which Dream keeps.
Spotify has no revoke endpoint, so Disconnect only forgets the tokens; people can remove Dream at
<https://www.spotify.com/account/apps>.

## GitHub

Register an **OAuth App**, not a GitHub App: OAuth App tokens act as the person across everything they can reach,
which is what agents need for `git push` and the REST API.

1. <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App** (to have an organization own it:
   the org's **Settings** → **Developer settings** → **OAuth Apps**).
2. **Application name** `Dream`, **Homepage URL** `https://dream.omer.build`, **Authorization callback URL**
   `https://dream.omer.build/oauth/github/callback`. Leave **Enable Device Flow** off. **Register application**.
3. Copy **Client ID** into `OAUTH_GITHUB_CLIENT_ID`. Click **Generate a new client secret** and copy it right away
   (it's shown once) into `OAUTH_GITHUB_CLIENT_SECRET`.

Quirks: OAuth App tokens don't expire, so there's nothing to refresh. The token goes on `api.github.com` and
`uploads.github.com` as a bearer token, and on `github.com` as Basic auth, so `git clone`/`push` over HTTPS work in
the sandbox with no credential helper. Organizations with OAuth app access restrictions have to approve Dream before
the token can reach their repositories (people can request it on the consent page). Disconnect in Settings deletes
the grant at GitHub.

## Strava

1. Log in at <https://www.strava.com/settings/api> (creating an API app needs a Strava subscription since June 2026)
   and fill in **My API Application**: **Application Name** `Dream`, a **Category**, **Website**
   `https://dream.omer.build`, and **Authorization Callback Domain** `dream.omer.build` (just the domain: no
   `https://`, no path). Upload the required icon and save.
2. The page then shows **Client ID** → `OAUTH_STRAVA_CLIENT_ID` and **Client Secret** → `OAUTH_STRAVA_CLIENT_SECRET`.
3. **Capacity**: a new app is in "Single Player Mode" (only you can connect). In the **API Settings Dashboard**, upgrade
   it to 10 athletes (self-service, no review). Beyond 10, submit the app for Strava's review.

Quirks: scopes are comma-separated (`read,activity:read_all`), which Dream handles. Access tokens last six hours, and
Strava can hand out a new refresh token on each refresh; Dream keeps the newest. Rate limits apply to the app as a
whole, shared by every person connected to it (by default 100 reads per 15 minutes and 1,000 a day). Strava is
moving its API to `api-v3.strava.com` during 2027 and will require its new `/oauth/revoke` endpoint by June 2027;
Dream already puts the token on both hosts, but Disconnect still calls the older `/oauth/deauthorize`, which needs
switching before then.

## Dropbox

1. <https://www.dropbox.com/developers/apps> → **Create app** → **Scoped access** → **Full Dropbox** (or **App folder**
   if agents should only see one folder) → a name (it must be unique across Dropbox, e.g. `Dream for Omer`) →
   **Create app**.
2. **Settings** tab → **OAuth 2** → **Redirect URIs**: add `https://dream.omer.build/oauth/dropbox/callback` → **Add**.
   Copy **App key** into `OAUTH_DROPBOX_CLIENT_ID` and **App secret** (click **Show**) into
   `OAUTH_DROPBOX_CLIENT_SECRET`.
3. **Permissions** tab: tick every scope agents may ask for, e.g. `account_info.read`, `files.metadata.read`,
   `files.metadata.write`, `files.content.read`, `files.content.write`, `sharing.read`, and **Submit**. A request for
   a scope that isn't ticked fails at Dropbox; a request that names none gets all the ticked ones.

Quirks: Dream asks for offline access (`token_access_type=offline`) so Dropbox issues a refresh token; access tokens
last about four hours. A development app can be linked by a limited number of users (500 at the time of writing)
before you apply for production. Disconnect revokes the token at Dropbox.

## Slack

Dream connects Slack as the person (a **user token**), so agents read and post as them in their workspace.

1. <https://api.slack.com/apps> → **Create New App** → **From scratch** → **App Name** `Dream`, pick a workspace you
   administer for development → **Create App**.
2. **OAuth & Permissions** → **Redirect URLs** → **Add New Redirect URL**
   `https://dream.omer.build/oauth/slack/callback` → **Add** → **Save URLs**.
3. Same page, **Scopes** → **User Token Scopes**: add the scopes agents may ask for, e.g. `users:read`,
   `channels:read`, `channels:history`, `groups:history`, `im:history`, `chat:write`, `search:read`. (Bot Token
   Scopes aren't used.)
4. **Manage Distribution** → complete the checklist → **Activate Public Distribution**, so people in other workspaces
   can install it. Without this only your development workspace works.
5. **Basic Information** → **App Credentials**: **Client ID** → `OAUTH_SLACK_CLIENT_ID`, **Client Secret** (Show) →
   `OAUTH_SLACK_CLIENT_SECRET`.

Quirks: leave **Token Rotation** off (tokens then don't expire); if it's on, Dream refreshes the 12-hour tokens.
Workspaces that require admin approval for apps hold the install until an admin approves it. Slack sharply throttles
`conversations.history` and `conversations.replies` for apps that aren't in its Marketplace, so agents are told to
read history sparingly. Disconnect revokes the token.

## Notion

1. <https://www.notion.so/profile/integrations> → **New integration** → type **Public** (Notion may call this a public
   connection), name `Dream`, the workspace that owns it, and the company details it asks for: name, website
   `https://dream.omer.build`, privacy policy and terms URLs, support email.
2. **Redirect URIs**: `https://dream.omer.build/oauth/notion/callback`.
3. **Capabilities**: tick read, update and insert content (and user information without email, at least), then
   **Save**.
4. **Configuration** tab: **OAuth Client ID** → `OAUTH_NOTION_CLIENT_ID`, **OAuth Client Secret** →
   `OAUTH_NOTION_CLIENT_SECRET`.

Quirks: Notion has no scopes. During consent the person picks which pages Dream can see; connecting again lets them
pick more. Tokens don't expire (if Notion returns a refresh token, Dream uses it). Notion has no revoke call Dream
uses; people remove Dream under **Settings** → **Connections** in Notion.

## Microsoft (Outlook, OneDrive, Calendar, To Do: Microsoft Graph)

1. <https://entra.microsoft.com> (any Microsoft account works; an Azure tenant is created for free if you have none) →
   **Applications** → **App registrations** → **New registration**.
2. **Name** `Dream`. **Supported account types**: **Accounts in any organizational directory and personal Microsoft
   accounts**. **Redirect URI**: platform **Web**, `https://dream.omer.build/oauth/microsoft/callback`. **Register**.
3. **Overview**: copy **Application (client) ID** into `OAUTH_MICROSOFT_CLIENT_ID`.
4. **Certificates & secrets** → **Client secrets** → **New client secret** → pick the longest expiry → **Add**, and copy
   the **Value** (not the Secret ID) into `OAUTH_MICROSOFT_CLIENT_SECRET`. Note the expiry date: when it lapses every
   Microsoft connection stops refreshing until you set a new one.

Quirks: Graph permissions (`Mail.Read`, `Calendars.ReadWrite`, `Files.ReadWrite`, …) are requested at sign-in, so
**API permissions** needs nothing added. Dream always adds `offline_access` to get a refresh token. The consent screen
shows Dream as an unverified publisher; personal accounts can consent anyway, but many work and school tenants block
consent to unverified apps or require an admin (publisher verification needs a Microsoft Partner Network account).
Microsoft rotates refresh tokens; Dream keeps the newest. There's no revoke call; people remove Dream at
<https://account.live.com/consent/Manage> or <https://myapps.microsoft.com>.

## Oura

1. Sign in at <https://cloud.ouraring.com/oauth/applications> → **New Application**: name `Dream`, description,
   website `https://dream.omer.build`, privacy policy and terms URLs, and **Redirect URIs**
   `https://dream.omer.build/oauth/oura/callback`. Allow the scopes agents may ask for (`email`, `personal`, `daily`,
   `heartrate`, `workout`, `tag`, `session`, `spo2`).
2. Copy **Client ID** → `OAUTH_OURA_CLIENT_ID` and **Client Secret** → `OAUTH_OURA_CLIENT_SECRET`.

Quirks: an unapproved Oura app is limited to 10 users; ask Oura to approve it for more. Oura retired personal access
tokens, so OAuth is the only way in. Most data needs the person to have an active Oura membership.

---

## Adding a provider

Most OAuth providers fit the same description. To add one without code, set the Worker secret `OAUTH_PROVIDERS` to a
JSON array of descriptions in the shape of `OAuthProviderSpec` (`apps/api/src/integrations/OAuth.ts`); an entry with
a shipped id replaces it. For example:

```json
[
  {
    "id": "linear",
    "service": "Linear",
    "authorizeUrl": "https://linear.app/oauth/authorize",
    "tokenUrl": "https://api.linear.app/oauth/token",
    "defaultScopes": ["read"],
    "scopeSeparator": ",",
    "hosts": [{ "host": "api.linear.app" }],
    "notes": "The API is GraphQL at https://api.linear.app/graphql."
  }
]
```

Then register Dream's app with the provider (redirect URI `https://dream.omer.build/oauth/linear/callback`) and set
`OAUTH_LINEAR_CLIENT_ID` and `OAUTH_LINEAR_CLIENT_SECRET`. The fields cover the usual differences: `pkce`,
`clientAuth` (`basic` or `body`), `tokenBody` (`form` or `json`), `scopeParam`, `authorizeParams`, `tokenPath` for a
token nested in the response, per-host `header`/`format` (`{token}`, or `{basic:<user>}` for Basic auth), `account`
(where to read who signed in), `revoke` and `notes` (told to the agent). An invalid `OAUTH_PROVIDERS` is ignored with a
warning in the Worker logs. Also add the provider to the list in `docs/prompts/skills/dream-access/access.md` (and run
`bun run sync-prompts`), or agents won't know to ask for it. A provider whose API needs signed requests rather than a
header (OAuth 1.0a, AWS-style signatures) can't be added this way.
