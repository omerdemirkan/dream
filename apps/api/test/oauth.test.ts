/**
 * OAuth providers, end to end (Google, whose token requests are the same protocol, at the end): the agent asks (`RequestAccess`), the phone starts the sign-in
 * (`StartOAuthAccess`), the provider redirects to the Worker's callback, and the token becomes an egress rule in
 * every sandbox, refreshed centrally until the provider refuses it. Providers are the real `OAuth` client talking
 * to `world.oauthResponses`.
 */
import { assert, describe, it } from "@effect/vitest"
import { type AccessMessage, AgentEvent, DaemonEnvFile, type ProjectId, renderAgentEvent } from "@dream/domain"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Connections } from "../src/db/Connections.ts"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { route } from "../src/http/Router.ts"
import { GoogleOAuthSpec } from "../src/integrations/Google.ts"
import { headersFor, OAuthCatalog, stringAt } from "../src/integrations/OAuth.ts"
import { CredentialStore } from "../src/integrations/CredentialStore.ts"
import { ProjectDirectory } from "../src/project/Client.ts"
import { maintenance } from "../src/WorkerLayer.ts"
import { makeCloud } from "./support/Cloud.ts"

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const claudeToken = `sk-ant-oat01-${"o".repeat(80)}`

const browser = (cloud: Cloud, url: string) =>
  Effect.gen(function* () {
    const raw = new Request(url)
    const response = yield* route(raw).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
      Effect.provide(Layer.succeedContext(cloud.workerContext))
    )
    const web = HttpServerResponse.toWeb(response)
    return { status: web.status, location: web.headers.get("location") ?? "" }
  })

/** Signs in, connects Claude through a connect link, creates a project and its sandbox; returns dreamd's client. */
const setup = (cloud: Cloud) =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({ email: "omer@example.com", secret: Redacted.make("dev-secret") })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
    const link = yield* cloud.phone.CreateConnectLink({ provider: "claude" })
    const raw = new Request("https://api.dream.test/connect/claude", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: new URL(link.url).searchParams.get("t")!, token: claudeToken }).toString()
    })
    yield* route(raw).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
      Effect.provide(Layer.succeedContext(cloud.workerContext))
    )
    const project = yield* cloud.phone.CreateProject({ idea: "A playlist that follows my runs." })
    yield* cloud.alarm(project.id)
    const dreamd = yield* cloud.sandbox(sandboxOf(cloud, project.id).env.DREAM_PROJECT_TOKEN!)
    return { project, dreamd }
  })

const sandboxOf = (cloud: Cloud, projectId: ProjectId) => {
  const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  const lines = sandbox.files.get(DaemonEnvFile)!.trim().split("\n")
  const env: Record<string, string> = Object.fromEntries(
    lines.map((line) => [line.slice(0, line.indexOf("=")), JSON.parse(line.slice(line.indexOf("=") + 1))])
  )
  return { sandbox, env }
}

const spotifyTokens = (access: string, refresh: string | undefined, expiresIn = 3600) => ({
  access_token: access,
  token_type: "Bearer",
  expires_in: expiresIn,
  scope: "user-read-private playlist-modify-private",
  ...(refresh === undefined ? {} : { refresh_token: refresh })
})

/** Asks for Spotify, starts it from the phone, and finishes the redirect. */
const connectSpotify = (cloud: Cloud, dreamd: Effect.Success<ReturnType<Cloud["sandbox"]>>, projectId: ProjectId) =>
  Effect.gen(function* () {
    const request = yield* dreamd.RequestAccess({
      request: { _tag: "OAuth", provider: "spotify", scopes: ["playlist-modify-private"] },
      why: "Build playlists from your runs."
    })
    const { authorizeUrl } = yield* cloud.phone.StartOAuthAccess({ projectId, messageId: request.id })
    const state = new URL(authorizeUrl).searchParams.get("state")!
    const callback = yield* browser(cloud, `https://api.dream.test/oauth/spotify/callback?code=code-1&state=${state}`)
    return { request, authorizeUrl, callback }
  })

const spotifyRoutes = (cloud: Cloud) => {
  cloud.world.oauthResponses.set("POST https://accounts.spotify.com/api/token", () => ({
    body: spotifyTokens("spotify-access-1", "spotify-refresh-1")
  }))
  cloud.world.oauthResponses.set("GET https://api.spotify.com/v1/me", () => ({
    body: { display_name: "Omer", id: "omer123" }
  }))
}

describe("OAuth providers", () => {
  it.live("refuses, at the moment it asks, a provider Dream doesn't know or this deployment hasn't set up", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const unknown = yield* dreamd
        .RequestAccess({ request: { _tag: "OAuth", provider: "myspace", scopes: [] }, why: "Old friends." })
        .pipe(Effect.flip)
      assert.strictEqual(unknown._tag, "InvalidRequest")
      assert.include(unknown.message, 'Dream has no OAuth provider called "myspace"')
      assert.include(unknown.message, "spotify, github, strava")
      assert.include(unknown.message, "dream access key")
      const unset = yield* dreamd
        .RequestAccess({ request: { _tag: "OAuth", provider: "strava", scopes: ["activity:read"] }, why: "Runs." })
        .pipe(Effect.flip)
      assert.include(unset.message, "Strava sign-in isn't set up on this deployment of Dream yet")
      assert.include(unset.message, "no card was shown")
      assert.include(unset.message, "Set up on this deployment: spotify, github, dropbox, slack, notion.")
      const history = yield* cloud.phone.ListMessages({ projectId: project.id })
      assert.isFalse(history.messages.some((message) => message._tag === "Access"))
      yield* cloud.close
    })
  )

  it.live("connects Spotify from the phone, once, into every sandbox's egress rules", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      spotifyRoutes(cloud)
      const { request, authorizeUrl, callback } = yield* connectSpotify(cloud, dreamd, project.id)

      // The card carries the display name; the scopes are what the agent named.
      assert.deepStrictEqual(request.request, {
        _tag: "OAuth",
        provider: "spotify",
        service: "Spotify",
        scopes: ["playlist-modify-private"]
      })
      const url = new URL(authorizeUrl)
      assert.strictEqual(url.origin + url.pathname, "https://accounts.spotify.com/authorize")
      assert.strictEqual(url.searchParams.get("client_id"), "spotify-client")
      assert.strictEqual(url.searchParams.get("redirect_uri"), "https://api.dream.test/oauth/spotify/callback")
      assert.strictEqual(url.searchParams.get("scope"), "playlist-modify-private")
      assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256")

      assert.strictEqual(callback.status, 302)
      const back = new URL(callback.location)
      assert.strictEqual(`${back.protocol}//${back.host}${back.pathname}`, "dream://oauth/spotify")
      assert.strictEqual(back.searchParams.get("error"), null)
      assert.strictEqual(back.searchParams.get("status"), "connected")
      assert.strictEqual(back.searchParams.get("messageId"), request.id)

      // The code exchange: Basic client auth, the PKCE verifier that matches the challenge, the same redirect.
      const exchange = cloud.world.oauthRequests.find((r) => r.url === "https://accounts.spotify.com/api/token")!
      assert.strictEqual(exchange.headers.authorization, `Basic ${btoa("spotify-client:spotify-secret")}`)
      const form = new URLSearchParams(exchange.body)
      assert.strictEqual(form.get("grant_type"), "authorization_code")
      assert.strictEqual(form.get("redirect_uri"), "https://api.dream.test/oauth/spotify/callback")
      assert.isNull(form.get("client_secret"))
      const digest = new Uint8Array(
        yield* Effect.promise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier")!))
        )
      )
      const challenge = btoa(String.fromCharCode(...digest))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
      assert.strictEqual(url.searchParams.get("code_challenge"), challenge)

      // Every sandbox of theirs carries it on api.spotify.com, and nothing stores it in the clear.
      const { sandbox } = sandboxOf(cloud, project.id)
      assert.deepStrictEqual(sandbox.rules["api.spotify.com"], [
        { transform: { headers: { Authorization: "Bearer spotify-access-1" } } }
      ])
      const stored = JSON.stringify(cloud.db.prepare("SELECT * FROM secrets").all())
      assert.notInclude(stored, "spotify-access-1")
      assert.notInclude(stored, "spotify-refresh-1")
      assert.notInclude(JSON.stringify(cloud.db.prepare("SELECT * FROM integrations").all()), "spotify-access-1")

      const [listed] = yield* dreamd.ListAccess()
      assert.deepStrictEqual(listed?.access, {
        _tag: "OAuth",
        provider: "spotify",
        service: "Spotify",
        account: "Omer",
        scopes: ["user-read-private", "playlist-modify-private"],
        hosts: ["api.spotify.com"],
        placeholder: "dream-spotify-oauth-placeholder",
        notes: OAuthCatalog.find((spec) => spec.id === "spotify")!.notes!
      })

      // The agent hears what's connected and how to use it.
      yield* cloud.alarm(project.id)
      const event = cloud.world.delivered.at(-1)!.events[0]
      if (!Schema.is(AgentEvent)(event)) return yield* Effect.die("not an agent event")
      assert.include(
        renderAgentEvent(event),
        "They connected Spotify as Omer (user-read-private, playlist-modify-private)."
      )
      assert.include(renderAgentEvent(event), 'placeholder "dream-spotify-oauth-placeholder"')

      // Connecting again from another request asks for what was granted before plus what's new.
      const again = yield* dreamd.RequestAccess({
        request: { _tag: "OAuth", provider: "spotify", scopes: ["user-top-read"] },
        why: "Use your top tracks."
      })
      const second = yield* cloud.phone.StartOAuthAccess({ projectId: project.id, messageId: again.id })
      assert.strictEqual(
        new URL(second.authorizeUrl).searchParams.get("scope"),
        "user-read-private playlist-modify-private user-top-read"
      )
      yield* cloud.close
    })
  )

  it.live("keeps the token fresh centrally, keeps rotated refresh tokens, and drops a refused one", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      spotifyRoutes(cloud)
      yield* connectSpotify(cloud, dreamd, project.id)
      const [integration] = yield* dreamd.ListAccess()
      const store = Context.get(cloud.workerContext, CredentialStore)
      const connections = Context.get(cloud.workerContext, Connections)
      const row = connections.integration(project.ownerId, integration!.id).pipe(Effect.map(Option.getOrThrow))

      // A refresh that rotates the refresh token: the next refresh spends the new one.
      cloud.world.oauthResponses.set("POST https://accounts.spotify.com/api/token", () => ({
        body: spotifyTokens("spotify-access-2", "spotify-refresh-2", 601)
      }))
      const refreshed = yield* store.oauth(yield* row, true)
      assert.strictEqual(refreshed.accessToken, "spotify-access-2")
      assert.strictEqual(refreshed.refreshToken, "spotify-refresh-2")
      const refresh = new URLSearchParams(cloud.world.oauthRequests.at(-1)!.body)
      assert.strictEqual(refresh.get("grant_type"), "refresh_token")
      assert.strictEqual(refresh.get("refresh_token"), "spotify-refresh-1")

      // The cron refreshes what expires within the margin and pushes it to the sandbox; Spotify kept the refresh token.
      cloud.world.oauthResponses.set("POST https://accounts.spotify.com/api/token", () => ({
        body: spotifyTokens("spotify-access-3", undefined, 601)
      }))
      yield* Effect.sleep("1500 millis")
      yield* maintenance.pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
      assert.strictEqual(
        new URLSearchParams(cloud.world.oauthRequests.at(-1)!.body).get("refresh_token"),
        "spotify-refresh-2"
      )
      assert.deepStrictEqual(sandboxOf(cloud, project.id).sandbox.rules["api.spotify.com"], [
        { transform: { headers: { Authorization: "Bearer spotify-access-3" } } }
      ])

      // They revoked Dream at Spotify: the cron's refresh is refused, the connection fails, and the rule goes.
      cloud.world.oauthResponses.set("POST https://accounts.spotify.com/api/token", () => ({
        status: 400,
        body: { error: "invalid_grant", error_description: "Refresh token revoked" }
      }))
      yield* Effect.sleep("1500 millis")
      yield* maintenance.pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
      assert.strictEqual((yield* row).status, "failed")
      assert.deepStrictEqual(yield* dreamd.ListAccess(), [])
      assert.isUndefined(sandboxOf(cloud, project.id).sandbox.rules["api.spotify.com"])
      yield* cloud.close
    })
  )

  it.live("a connection the provider stops renewing: the projects that asked hear, and hear when it's back", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      spotifyRoutes(cloud)
      // An access token that's due for a refresh as soon as anything builds a sandbox's rules.
      cloud.world.oauthResponses.set("POST https://accounts.spotify.com/api/token", () => ({
        body: spotifyTokens("spotify-access-1", "spotify-refresh-1", 601)
      }))
      const { request } = yield* connectSpotify(cloud, dreamd, project.id)
      const other = yield* cloud.phone.CreateProject({ idea: "A wake-up song that fits the weather." })
      yield* cloud.alarm(other.id)
      const otherDreamd = yield* cloud.sandbox(sandboxOf(cloud, other.id).env.DREAM_PROJECT_TOKEN!)
      const bystander = yield* cloud.phone.CreateProject({ idea: "Something that never plays music." })
      yield* cloud.alarm(bystander.id)
      yield* cloud.alarm(project.id)
      const [integration] = yield* dreamd.ListAccess()
      const connections = Context.get(cloud.workerContext, Connections)
      const row = connections.integration(project.ownerId, integration!.id).pipe(Effect.map(Option.getOrThrow))
      const cardOf = (projectId: ProjectId, messageId: string) =>
        Effect.map(cloud.phone.ListMessages({ projectId }), ({ messages }) =>
          messages.find((m): m is AccessMessage => m._tag === "Access" && m.id === messageId)
        )

      // They revoked Dream at Spotify, and a project's DO is the first to refresh (building its sandbox's rules),
      // not the cron.
      cloud.world.oauthResponses.set("POST https://accounts.spotify.com/api/token", () => ({
        status: 400,
        body: { error: "invalid_grant", error_description: "Refresh token revoked" }
      }))
      yield* Effect.sleep("1500 millis")
      const before = cloud.world.delivered.length
      yield* Context.get(cloud.workerContext, ProjectDirectory).credentialsChanged(project.ownerId)
      yield* Effect.sleep("300 millis")
      assert.strictEqual((yield* row).status, "failed")
      const card = yield* cardOf(project.id, request.id)
      assert.deepStrictEqual(card?.state._tag === "Disconnected" && card.state.reason, "failed")
      for (const id of [project.id, other.id, bystander.id]) yield* cloud.alarm(id)
      const told = cloud.world.delivered.slice(before)
      assert.deepStrictEqual(
        told.map((d) => d.sandboxId),
        [sandboxOf(cloud, project.id).sandbox.access.sandboxId]
      )
      const event = told[0]!.events[0]
      if (!Schema.is(AgentEvent)(event)) return yield* Effect.die("not an agent event")
      assert.include(
        renderAgentEvent(event),
        "Their Spotify connection stopped working: Spotify refused to renew it (invalid_grant). HTTPS requests to " +
          "api.spotify.com no longer carry their credential."
      )
      assert.include(renderAgentEvent(event), "`dream access oauth spotify`")

      // The other project asks for it, and they connect it from there: its card answers, and the first project's
      // card is connected again, with its agent told it's back.
      spotifyRoutes(cloud)
      const { request: otherRequest } = yield* connectSpotify(cloud, otherDreamd, other.id)
      assert.strictEqual((yield* cardOf(other.id, otherRequest.id))?.state._tag, "Connected")
      assert.strictEqual((yield* cardOf(project.id, request.id))?.state._tag, "Connected")
      const back = cloud.world.delivered.length
      yield* cloud.alarm(project.id)
      yield* cloud.alarm(other.id)
      const restored = cloud.world.delivered.slice(back).map((d) => d.events.map((e: any) => [e._tag, e.change]))
      assert.deepStrictEqual(restored, [[["AccessConnected", "restored"]], [["AccessConnected", undefined]]])
      assert.deepStrictEqual(sandboxOf(cloud, project.id).sandbox.rules["api.spotify.com"], [
        { transform: { headers: { Authorization: "Bearer spotify-access-1" } } }
      ])
      // Settings replaces only pasted keys.
      const notKey = yield* cloud.phone
        .ReplaceKey({ integrationId: integration!.id, key: Redacted.make("BQ-pasted") })
        .pipe(Effect.flip)
      assert.strictEqual(notKey._tag, "InvalidRequest")
      yield* cloud.close
    })
  )

  it.live("GitHub: a lasting token on the API and on git over HTTPS; disconnecting deletes the grant", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      cloud.world.oauthResponses.set("POST https://github.com/login/oauth/access_token", () => ({
        body: { access_token: "gho_abc", token_type: "bearer", scope: "repo,read:user" }
      }))
      cloud.world.oauthResponses.set("GET https://api.github.com/user", () => ({ body: { login: "octocat" } }))
      cloud.world.oauthResponses.set("DELETE https://api.github.com/applications/github-client/grant", () => ({
        status: 204,
        body: null
      }))
      const request = yield* dreamd.RequestAccess({
        request: { _tag: "OAuth", provider: "GitHub", scopes: ["repo"] },
        why: "Push the code to your account."
      })
      const { authorizeUrl } = yield* cloud.phone.StartOAuthAccess({ projectId: project.id, messageId: request.id })
      const state = new URL(authorizeUrl).searchParams.get("state")!
      // A state is only good for the provider it was made for.
      const crossed = yield* browser(cloud, `https://api.dream.test/oauth/spotify/callback?code=c&state=${state}`)
      assert.strictEqual(new URL(crossed.location).searchParams.get("error"), "expired")
      // A cancelled consent comes back as cancelled, and the request stays open.
      const cancelled = yield* browser(
        cloud,
        `https://api.dream.test/oauth/github/callback?error=access_denied&state=${state}`
      )
      assert.strictEqual(new URL(cancelled.location).searchParams.get("error"), "cancelled")
      const retry = yield* cloud.phone.StartOAuthAccess({ projectId: project.id, messageId: request.id })
      const retryState = new URL(retry.authorizeUrl).searchParams.get("state")!
      yield* browser(cloud, `https://api.dream.test/oauth/github/callback?code=c&state=${retryState}`)

      const exchange = cloud.world.oauthRequests.find((r) => r.url === "https://github.com/login/oauth/access_token")!
      assert.strictEqual(exchange.headers.accept, "application/json")
      assert.strictEqual(new URLSearchParams(exchange.body).get("client_secret"), "github-secret")
      const me = cloud.world.oauthRequests.find((r) => r.url === "https://api.github.com/user")!
      assert.strictEqual(me.headers["user-agent"], "Dream")

      const { sandbox } = sandboxOf(cloud, project.id)
      assert.deepStrictEqual(sandbox.rules["api.github.com"], [
        { transform: { headers: { Authorization: "Bearer gho_abc" } } }
      ])
      assert.deepStrictEqual(sandbox.rules["github.com"], [
        { transform: { headers: { Authorization: `Basic ${btoa("x-access-token:gho_abc")}` } } }
      ])
      const [integration] = yield* cloud.phone.ListIntegrations()
      assert.strictEqual(integration?.access._tag === "OAuth" && integration.access.account, "octocat")
      assert.deepStrictEqual(integration?.access._tag === "OAuth" && integration.access.scopes, ["repo", "read:user"])
      assert.isNull(
        (cloud.db.prepare("SELECT access_expires_at_ms FROM integrations").all()[0] as Record<string, unknown>)
          .access_expires_at_ms
      )

      yield* cloud.phone.DisconnectIntegration({ integrationId: integration!.id })
      const revoke = cloud.world.oauthRequests.at(-1)!
      assert.strictEqual(revoke.method, "DELETE")
      assert.strictEqual(revoke.headers.authorization, `Basic ${btoa("github-client:github-secret")}`)
      assert.deepStrictEqual(JSON.parse(revoke.body), { access_token: "gho_abc" })
      assert.isUndefined(sandboxOf(cloud, project.id).sandbox.rules["github.com"])
      yield* cloud.close
    })
  )

  it.live("Slack: user scopes, and the user token nested in Slack's answer", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      cloud.world.oauthResponses.set("POST https://slack.com/api/oauth.v2.access", () => ({
        body: {
          ok: true,
          app_id: "A1",
          team: { id: "T1", name: "Cabin Crew" },
          authed_user: { id: "U1", scope: "channels:history,users:read", access_token: "xoxp-1", token_type: "user" }
        }
      }))
      const request = yield* dreamd.RequestAccess({
        request: { _tag: "OAuth", provider: "slack", scopes: ["channels:history", "users:read"] },
        why: "Summarize #trips every morning."
      })
      const { authorizeUrl } = yield* cloud.phone.StartOAuthAccess({ projectId: project.id, messageId: request.id })
      const url = new URL(authorizeUrl)
      assert.strictEqual(url.searchParams.get("user_scope"), "channels:history,users:read")
      assert.isNull(url.searchParams.get("scope"))
      assert.isNull(url.searchParams.get("code_challenge"))
      yield* browser(
        cloud,
        `https://api.dream.test/oauth/slack/callback?code=c&state=${url.searchParams.get("state")!}`
      )
      const { sandbox } = sandboxOf(cloud, project.id)
      assert.deepStrictEqual(sandbox.rules["slack.com"], [
        { transform: { headers: { Authorization: "Bearer xoxp-1" } } }
      ])
      const [integration] = yield* dreamd.ListAccess()
      assert.strictEqual(integration?.access._tag === "OAuth" && integration.access.account, "Cabin Crew")

      // Slack answers errors with 200 and ok: false.
      cloud.world.oauthResponses.set("POST https://slack.com/api/oauth.v2.access", () => ({
        body: { ok: false, error: "invalid_code" }
      }))
      const again = yield* cloud.phone
        .StartOAuthAccess({ projectId: project.id, messageId: request.id })
        .pipe(Effect.flip)
      assert.strictEqual(again._tag, "InvalidRequest")
      yield* cloud.close
    })
  )
})

describe("provider descriptions", () => {
  it("writes each host's header, including Basic for git", () => {
    const github = OAuthCatalog.find((spec) => spec.id === "github")!
    assert.deepStrictEqual(headersFor(github, "t0k"), [
      ["api.github.com", "Authorization", "Bearer t0k"],
      ["uploads.github.com", "Authorization", "Bearer t0k"],
      ["github.com", "Authorization", `Basic ${btoa("x-access-token:t0k")}`]
    ])
  })

  it("reads dotted paths from provider answers", () => {
    assert.strictEqual(stringAt({ athlete: { username: "omer" } }, "athlete.username"), "omer")
    assert.isUndefined(stringAt({ athlete: null }, "athlete.username"))
    assert.isUndefined(stringAt({ name: "" }, "name"))
  })

  it("ships every provider with an id, endpoints on https, and at least one host", () => {
    const ids = OAuthCatalog.map((spec) => spec.id)
    assert.deepStrictEqual(ids, [...new Set(ids)])
    for (const spec of OAuthCatalog) {
      assert.match(spec.authorizeUrl, /^https:\/\//, spec.id)
      assert.match(spec.tokenUrl, /^https:\/\//, spec.id)
      assert.isAbove(spec.hosts.length, 0, spec.id)
    }
  })
})

/** Asks for Gmail, starts it from the phone, and finishes Google's redirect. */
const connectGoogle = (cloud: Cloud, dreamd: Effect.Success<ReturnType<Cloud["sandbox"]>>, projectId: ProjectId) =>
  Effect.gen(function* () {
    const request = yield* dreamd.RequestAccess({
      request: { _tag: "Google", scopes: ["gmail.readonly"] },
      why: "Find the cabin booking confirmations."
    })
    const { authorizeUrl } = yield* cloud.phone.StartGoogleAccess({ projectId, messageId: request.id })
    const state = new URL(authorizeUrl).searchParams.get("state")!
    const callback = yield* browser(cloud, `https://api.dream.test/oauth/google/callback?code=code-1&state=${state}`)
    return { request, callback }
  })

const googleToken = `POST ${GoogleOAuthSpec.tokenUrl}`

const cardOf = (cloud: Cloud, projectId: ProjectId, messageId: string) =>
  Effect.map(cloud.phone.ListMessages({ projectId }), ({ messages }) =>
    messages.find((m): m is AccessMessage => m._tag === "Access" && m.id === messageId)
  )

describe("Google", () => {
  it.live("refuses, at the moment it asks, when this deployment has no Google client", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud({ googleClientId: Option.none() })
      const { project, dreamd } = yield* setup(cloud)
      const refused = yield* dreamd
        .RequestAccess({ request: { _tag: "Google", scopes: ["gmail.send"] }, why: "Email the cabin host." })
        .pipe(Effect.flip)
      assert.strictEqual(refused._tag, "InvalidRequest")
      assert.include(refused.message, "Google sign-in isn't set up on this deployment of Dream yet")
      assert.include(refused.message, "no card was shown")
      const history = yield* cloud.phone.ListMessages({ projectId: project.id })
      assert.isFalse(history.messages.some((message) => message._tag === "Access"))
      yield* cloud.close
    })
  )

  it.live("retries what isn't a refusal; a refused refresh token fails it, the projects that asked hear", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      // A dreamd that knows `AccessRemoved` for connections other than OAuth providers'.
      cloud.world.templateBuilds.set("dream-sandbox", { build: "b1", release: "r1" })
      const google = cloud.world.oauthResponses.get(googleToken)!
      const { project, dreamd } = yield* setup(cloud)
      const { request, callback } = yield* connectGoogle(cloud, dreamd, project.id)
      assert.strictEqual(new URL(callback.location).searchParams.get("status"), "connected")
      const exchange = new URLSearchParams(cloud.world.oauthRequests.at(-1)!.body)
      assert.strictEqual(exchange.get("grant_type"), "authorization_code")
      assert.strictEqual(exchange.get("redirect_uri"), "https://api.dream.test/oauth/google/callback")
      assert.strictEqual(exchange.get("client_secret"), "google-secret")
      const bystander = yield* cloud.phone.CreateProject({ idea: "Something that never reads email." })
      yield* cloud.alarm(bystander.id)
      yield* cloud.alarm(project.id)

      const [integration] = yield* dreamd.ListAccess()
      assert.strictEqual(integration?.access._tag === "Google" && integration.access.email, "omer@example.com")
      const connections = Context.get(cloud.workerContext, Connections)
      const row = connections.integration(project.ownerId, integration!.id).pipe(Effect.map(Option.getOrThrow))
      const gmailRule = () => sandboxOf(cloud, project.id).sandbox.rules["gmail.googleapis.com"]
      assert.deepStrictEqual(gmailRule(), [{ transform: { headers: { Authorization: "Bearer google-access-1" } } }])

      // A refresh that leaves the access token due again by the next sweep.
      const renews = (access: string) => () => ({ body: { access_token: access, expires_in: 601 } })
      cloud.world.oauthResponses.set(googleToken, renews("google-access-2"))
      yield* Context.get(cloud.workerContext, CredentialStore).google(yield* row, true)
      yield* Effect.sleep("1500 millis")

      // Google erroring, unreachable, or refusing Dream's own client: none of it is their grant, so the connection
      // stays, the agent hears nothing, and the next sweep tries again.
      const before = cloud.world.delivered.length
      const blips: ReadonlyArray<() => { status?: number; body: unknown }> = [
        () => ({ status: 503, body: { error: "backend_error" } }),
        () => ({ status: 429, body: { error: "rate_limit_exceeded" } }),
        () => {
          throw new TypeError("fetch failed")
        },
        () => ({ status: 401, body: { error: "invalid_client", error_description: "The OAuth client was not found." } })
      ]
      for (const blip of blips) {
        cloud.world.oauthResponses.set(googleToken, blip)
        const attempts = cloud.world.oauthRequests.length
        yield* maintenance.pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
        assert.strictEqual(cloud.world.oauthRequests.length, attempts + 1)
        assert.strictEqual((yield* row).status, "connected")
      }
      for (const id of [project.id, bystander.id]) yield* cloud.alarm(id)
      assert.strictEqual(cloud.world.delivered.length, before)
      assert.strictEqual((yield* cardOf(cloud, project.id, request.id))?.state._tag, "Connected")

      // Google answers again: the sweep renews it and the sandbox gets the new token.
      cloud.world.oauthResponses.set(googleToken, renews("google-access-3"))
      yield* maintenance.pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
      assert.deepStrictEqual(gmailRule(), [{ transform: { headers: { Authorization: "Bearer google-access-3" } } }])
      yield* Effect.sleep("1500 millis")

      // They revoked Dream in their Google account: the refresh is refused, the connection fails and leaves the
      // sandbox, the card says it stopped working, and only the project that asked for it hears why.
      cloud.world.oauthResponses.set(googleToken, () => ({
        status: 400,
        body: { error: "invalid_grant", error_description: "Token has been expired or revoked." }
      }))
      yield* maintenance.pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
      assert.strictEqual((yield* row).status, "failed")
      assert.deepStrictEqual(yield* dreamd.ListAccess(), [])
      assert.isUndefined(gmailRule())
      const card = yield* cardOf(cloud, project.id, request.id)
      assert.deepStrictEqual(card?.state._tag === "Disconnected" && card.state.reason, "failed")
      const lapsedAt = cloud.world.delivered.length
      for (const id of [project.id, bystander.id]) yield* cloud.alarm(id)
      const told = cloud.world.delivered.slice(lapsedAt)
      assert.deepStrictEqual(
        told.map((d) => d.sandboxId),
        [sandboxOf(cloud, project.id).sandbox.access.sandboxId]
      )
      const event = told[0]!.events[0]
      if (!Schema.is(AgentEvent)(event)) return yield* Effect.die("not an agent event")
      assert.include(
        renderAgentEvent(event),
        "Their Gmail connection stopped working: Google refused to renew it (invalid_grant)."
      )
      assert.include(renderAgentEvent(event), "`dream access google`")

      // They connect it again from the card: it's connected, and the token is back in the sandbox.
      cloud.world.oauthResponses.set(googleToken, google)
      yield* connectGoogle(cloud, dreamd, project.id).pipe(Effect.asVoid)
      assert.strictEqual((yield* row).status, "connected")
      yield* cloud.alarm(project.id)
      assert.deepStrictEqual(gmailRule(), [{ transform: { headers: { Authorization: "Bearer google-access-1" } } }])
      yield* cloud.close
    })
  )
})
