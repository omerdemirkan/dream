/**
 * `dream email`: the agent's markdown rendered into Dream's email and sent to the project owner's own address, with
 * a copy in Chat. What the renderer lets through (no raw HTML, only http(s) and mailto links, a link's host shown
 * when its text isn't its address), and what the call is held to: the owner only, a daily limit per project,
 * nothing sent on a bad flag, and a clear failure when the deployment can't send.
 */
import { assert, describe, it } from "@effect/vitest"
import { AgentEmailLimits, DaemonEnvFile, type ProjectId, type TextMessage, type WorkstreamId } from "@dream/domain"
import { Effect, Layer, Redacted } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { agentEmail, renderMarkdown } from "../src/email/AgentEmail.ts"
import { route } from "../src/http/Router.ts"
import { makeCloud } from "./support/Cloud.ts"

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

describe("rendering the agent's markdown", () => {
  it("renders headings, numbered steps, code and tables with inline styles", () => {
    const html = renderMarkdown(
      "# Big\n\n## Part\n\n1. Open it\n2. Click **Continue**\n   - nested\n\n```\nTeam ID: 7XQ\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |"
    )
    // The subject is the email's h1, so the agent's headings start at h2.
    assert.match(html, /<h2 style="[^"]+">Big<\/h2>/)
    assert.match(html, /<h3 style="[^"]+">Part<\/h3>/)
    assert.notInclude(html, "<h1")
    assert.match(html, /<ol style="[^"]+">\s*<li style="[^"]+">Open it<\/li>/)
    assert.match(html, /<strong style="[^"]+">Continue<\/strong>/)
    assert.match(html, /<ul style="margin:6px 0 0;/)
    assert.match(html, /<pre style="[^"]+">Team ID: 7XQ<\/pre>/)
    assert.match(html, /<table style="[^"]+">/)
    assert.match(html, /<td style="[^"]+">2<\/td>/)
  })

  it("escapes raw HTML instead of passing it through", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\nHi <img src=x onerror="alert(1)"> <a href="https://evil.example">x</a>\n\n<div style="display:none">hidden</div>'
    )
    assert.notInclude(html, "<script")
    assert.notInclude(html, "<img")
    assert.notInclude(html, "<div")
    // The address in it may still be linked, as text; the tag itself is not.
    assert.notMatch(html, /<a [^>]*>x<\/a>/)
    assert.include(html, "&lt;script&gt;")
    assert.include(html, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
  })

  it("links only to the web and to addresses", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "vbscript:x",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "/relative/path",
      "ftp://example.com/x"
    ]) {
      const html = renderMarkdown(`[click](${url})`)
      assert.notInclude(html, "<a ", url)
    }
    assert.include(renderMarkdown("[mail me](mailto:ada@example.com)"), 'href="mailto:ada@example.com"')
    assert.include(renderMarkdown("<javascript:alert(1)>"), "&lt;javascript:alert(1)&gt;")
  })

  it("shows where a link goes when its text doesn't say", () => {
    const named = renderMarkdown("[Your bank](https://login.evil.example/apple)")
    assert.include(named, 'href="https://login.evil.example/apple"')
    assert.include(named, "(login.evil.example)")
    assert.include(named, 'rel="noopener noreferrer"')
    // A link that is its own address, or names its host, needs nothing more.
    assert.notInclude(renderMarkdown("https://developer.apple.com/account"), "(developer.apple.com)")
    assert.notInclude(renderMarkdown("[developer.apple.com](https://developer.apple.com/)"), "(developer.apple.com)")
    // Text that looks like another site's address is the case that matters most.
    assert.include(renderMarkdown("[https://apple.com](https://apple.com.evil.example)"), "(apple.com.evil.example)")
    assert.include(renderMarkdown("[write to us](mailto:help@example.com?subject=x)"), "(help@example.com)")
  })

  it("turns images into links, so nothing loads when they open it", () => {
    const html = renderMarkdown("![Where to click](https://tracker.example/pixel.png)")
    assert.notInclude(html, "<img")
    assert.include(html, 'href="https://tracker.example/pixel.png"')
    assert.include(html, "Where to click")
    assert.include(html, "(image on tracker.example)")
    assert.notInclude(renderMarkdown("![x](javascript:alert(1))"), "href")
  })

  it("keeps code verbatim and escaped", () => {
    const html = renderMarkdown("Run `rm -rf <dir>` then:\n\n```html\n<b>&amp;</b>\n```")
    assert.include(html, "rm -rf &lt;dir&gt;")
    assert.include(html, "&lt;b&gt;&amp;amp;&lt;/b&gt;")
  })

  it("frames it as Dream's, with a plain-text part, whatever the subject holds", () => {
    const mail = agentEmail({
      to: "ada@example.com",
      subject: "  Set up   <b>Apple</b>\n Developer ",
      markdown: "1. Open [the page](https://developer.apple.com)",
      project: "Tide <Clock>"
    })
    assert.strictEqual(mail.to, "ada@example.com")
    assert.strictEqual(mail.subject, "Set up <b>Apple</b> Developer")
    assert.include(mail.html, "<title>Set up &lt;b&gt;Apple&lt;/b&gt; Developer</title>")
    assert.include(mail.html, "Tide &lt;Clock&gt; · Dream")
    assert.include(mail.html, "The agent building Tide &lt;Clock&gt; wrote this in Dream")
    assert.include(mail.text, "1. Open [the page](https://developer.apple.com)")
    assert.include(mail.text, "From Tide <Clock>, in Dream.")
    assert.include(mail.text, "email replies don't reach it")
  })
})

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

const claudeToken = `sk-ant-oat01-${"e".repeat(80)}`

const sandboxEnv = (cloud: Cloud, projectId: ProjectId) => {
  const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  const lines = sandbox.files.get(DaemonEnvFile)!.trim().split("\n")
  return Object.fromEntries(
    lines.map((line) => [line.slice(0, line.indexOf("=")), JSON.parse(line.slice(line.indexOf("=") + 1))])
  ) as Record<string, string>
}

const connectClaude = (cloud: Cloud) =>
  Effect.gen(function* () {
    const link = yield* cloud.phone.CreateConnectLink({ provider: "claude" })
    const raw = new Request(`https://api.dream.test/connect/claude`, {
      method: "POST",
      headers: { origin: "https://api.dream.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: new URL(link.url).searchParams.get("t")!, token: claudeToken }).toString()
    })
    yield* route(raw).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
      Effect.provide(Layer.succeedContext(cloud.workerContext)),
      Effect.map(HttpServerResponse.toWeb)
    )
  })

const setup = (cloud: Cloud, email = "ada@example.com") =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({ email, secret: Redacted.make("dev-secret") })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
    yield* connectClaude(cloud)
    const project = yield* cloud.phone.CreateProject({ idea: "Tide Clock, an app for the tides." })
    yield* cloud.alarm(project.id)
    const dreamd = yield* cloud.sandbox(sandboxEnv(cloud, project.id).DREAM_PROJECT_TOKEN!)
    return { project, dreamd }
  })

const emailed = (cloud: Cloud, projectId: ProjectId) =>
  Effect.map(cloud.phone.ListMessages({ projectId }), ({ messages }) =>
    messages.filter((m): m is TextMessage => m._tag === "Text" && m.email !== undefined)
  )

const steps =
  "## Register the identifier\n\n1. Open [Identifiers](https://developer.apple.com/account/resources)\n2. Click **+**"

describe("dream email", () => {
  it.live("emails the owner the rendered markdown, from Dream, and puts a copy in Chat", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const sent = yield* dreamd.SendEmail({ subject: "Set up Tide Clock in Apple Developer", markdown: steps })
      assert.strictEqual(cloud.mail.sent.length, 1)
      // Metered to the project as one message.
      const metered = cloud.db.prepare("SELECT meter, project_id, units FROM meter_events").all()
      assert.deepStrictEqual(
        metered.map((row) => [row.meter, row.units]),
        [["email_sent", 1]]
      )
      const mail = cloud.mail.sent[0]!
      assert.strictEqual(mail.to, "ada@example.com")
      assert.strictEqual(mail.from.name, "Dream")
      assert.match(mail.from.email, /^dream@mail\./)
      assert.strictEqual(mail.subject, "Set up Tide Clock in Apple Developer")
      assert.include(mail.html, "<h3")
      assert.include(mail.html, 'href="https://developer.apple.com/account/resources"')
      assert.include(mail.text, "1. Open [Identifiers]")
      assert.strictEqual(mail.headers?.["Auto-Submitted"], "auto-generated")

      assert.strictEqual(sent.from, "agent")
      assert.strictEqual(sent.text, steps)
      assert.deepStrictEqual(
        { subject: sent.email?.subject, to: sent.email?.to },
        { subject: "Set up Tide Clock in Apple Developer", to: "ada@example.com" }
      )
      const inChat = yield* emailed(cloud, project.id)
      assert.deepStrictEqual(
        inChat.map((m) => m.id),
        [sent.id]
      )
      // A copy in Chat is a record, not a notification: the email reached them already.
      assert.isUndefined(inChat[0]!.notificationId)
    })
  )

  it.live("refuses what it can't send, and sends nothing when a flag is wrong", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const multiline = yield* dreamd.SendEmail({ subject: "Line one\nline two", markdown: steps }).pipe(Effect.flip)
      assert.strictEqual(multiline._tag, "InvalidRequest")
      const long = yield* dreamd
        .SendEmail({ subject: "Steps", markdown: "x".repeat(AgentEmailLimits.markdown + 1) })
        .pipe(Effect.flip)
      assert.strictEqual(long._tag, "InvalidRequest")
      const badWork = yield* dreamd
        .SendEmail({ subject: "Steps", markdown: steps, workstream: "ws_nope" as WorkstreamId })
        .pipe(Effect.flip)
      assert.strictEqual(badWork._tag, "InvalidRequest")
      const badReply = yield* dreamd
        .SendEmail({ subject: "Steps", markdown: steps, replyTo: "msg_nope" as never })
        .pipe(Effect.flip)
      assert.strictEqual(badReply._tag, "NotFound")
      assert.strictEqual(cloud.mail.sent.length, 0)
      assert.lengthOf(yield* emailed(cloud, project.id), 0)
    })
  )

  it.live("goes in a thread and workstream like a message", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { dreamd } = yield* setup(cloud)
      const { workstreams } = yield* dreamd.StartWorkstream({ title: "TestFlight" })
      const work = workstreams.at(-1)!.id
      const question = yield* dreamd.AskQuestion({
        question: "Can you set up Apple Developer?",
        options: ["Email me the steps", "I'll do it later"],
        workstream: work
      })
      const sent = yield* dreamd.SendEmail({ subject: "Apple Developer steps", markdown: steps, replyTo: question.id })
      assert.strictEqual(sent.replyTo, question.id)
      assert.strictEqual(sent.workstream, work)
    })
  )

  it.live("stops at the daily limit, with a typed error that says so", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      for (let i = 0; i < AgentEmailLimits.perProjectPerDay; i++) {
        yield* dreamd.SendEmail({ subject: `Steps ${i}`, markdown: steps })
      }
      const refused = yield* dreamd.SendEmail({ subject: "One more", markdown: steps }).pipe(Effect.flip)
      assert.strictEqual(refused._tag, "EmailLimitReached")
      if (refused._tag === "EmailLimitReached") {
        assert.strictEqual(refused.limit, AgentEmailLimits.perProjectPerDay)
        assert.include(refused.message, "wasn't sent")
      }
      assert.strictEqual(cloud.mail.sent.length, AgentEmailLimits.perProjectPerDay)
      assert.lengthOf(yield* emailed(cloud, project.id), AgentEmailLimits.perProjectPerDay)
    })
  )

  it.live("fails clearly, and records nothing, when the deployment can't send or the send fails", () =>
    Effect.gen(function* () {
      const off = yield* makeCloud({}, { noEmail: true })
      const offProject = yield* setup(off)
      const refused = yield* offProject.dreamd.SendEmail({ subject: "Steps", markdown: steps }).pipe(Effect.flip)
      assert.strictEqual(refused._tag, "UpstreamFailure")
      if (refused._tag === "UpstreamFailure") assert.include(refused.message, "nothing was sent")
      assert.lengthOf(yield* emailed(off, offProject.project.id), 0)

      const failing = yield* makeCloud()
      const { project, dreamd } = yield* setup(failing)
      failing.mail.failWith = "E_RECIPIENT_SUPPRESSED"
      const failed = yield* dreamd.SendEmail({ subject: "Steps", markdown: steps }).pipe(Effect.flip)
      assert.strictEqual(failed._tag, "UpstreamFailure")
      if (failed._tag === "UpstreamFailure") {
        assert.include(failed.message, "E_RECIPIENT_SUPPRESSED")
        assert.notInclude(failed.message, "Register the identifier")
      }
      assert.lengthOf(yield* emailed(failing, project.id), 0)
    })
  )
})
