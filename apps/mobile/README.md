# @dream/mobile

Dream's iPhone app: Expo SDK 58 (React Native 0.88), expo-router, Effect 4.1 with `@effect/atom-react`. The design
is Deck v3 (`mocks/deck-v3.html`), with two changes: "Something else…" (typed or dictated) lives only in the
expanded view, and Home has no needs-you deck. Questions and access requests stay in their project (Chat, the Status
card, notifications); Home's project rows say which projects are waiting for them.

## Layout

| Path | What |
| --- | --- |
| `src/app` | Routes: Home (`index`), `project/[id]` (Chat with the Status card on top), `new`, `sign-in`, `connect`, `settings`, `oauth/google`, `oauth/[provider]`, `fixtures/[scenario]` |
| `src/data` | Services (no React Native): `AppClient` (AppRpcs over HTTP), `LiveProjects` (ProjectLiveRpcs over WebSocket, re-subscribing with a fresh ticket), `ProjectStates`, `Answers`, `Session`, formatting |
| `src/fake` | The fixtures backend: `AppRpcs` handlers and live events over the Deck v3 sample world, with a small simulated agent |
| `src/state` | The atom runtime and the atoms screens use |
| `src/platform` | Expo/iOS pieces: keychain, streaming fetch, push, dictation, Google Sign-In |
| `src/ui` | Components: the Status card and its roadmap, Chat messages, the expanded view and its grow/shrink animation |
| `modules/dream-native` | Local Expo module (Swift): Live Activity push-to-start and update tokens, launch arguments |
| `targets/widget` | The Live Activity widget (lock screen + Dynamic Island), via `@bacons/apple-targets` |
| `scripts/build-ios.sh` | `expo prebuild` + CocoaPods + `xcodebuild`, for the Simulator or TestFlight |
| `scripts/updates.ts` | Over-the-air updates: publish, roll back, status (below) |
| `certs/updates-certificate.pem` | The update signing certificate every build embeds |

## Configuration

`app.config.ts` reads these at build time (`expo prebuild`, `expo start`):

| Variable | Default | |
| --- | --- | --- |
| `DREAM_BACKEND` | `fixtures` | `fixtures` runs against the in-app fake; `live` talks to the API |
| `DREAM_API_URL` | `https://dream.omer.build` | RPC at `/rpc`, live sockets via `GetLiveUrl`, media at `/media/:id` |
| `DREAM_BUNDLE_ID` | `build.omer.dream` | registered on team ZY6RS9293V |
| `DREAM_APPLE_TEAM_ID` | — | needed to sign the app and the widget |
| `DREAM_GOOGLE_IOS_CLIENT_ID` | — | enables native Google Sign-In (adds its URL scheme) |
| `DREAM_GOOGLE_WEB_CLIENT_ID` | — | optional: Google's ID token audience becomes the web client |
| `DREAM_APS_ENVIRONMENT` | `development` | APNs entitlement; the TestFlight build uses `production` |
| `DREAM_UPDATES_CHANNEL` | see below | the over-the-air update channel the build follows |
| `DREAM_UPDATES_URL` | `<DREAM_API_URL>/updates/manifest` | the update server |
| `DREAM_UPDATES_CERTIFICATE` | `certs/updates-certificate.pem` | the certificate updates must be signed for; without the file, the build takes no updates |
| `DREAM_UPDATES_ENABLED` | — | `1` gives a build that isn't for TestFlight over-the-air updates (on by default only with `DREAM_APS_ENVIRONMENT=production`) |

`scripts/build-env.sh` holds the defaults builds are made with (`build-ios.sh` and publishing both read it).

## Running

```sh
bun install                        # from the repo root
bun run --filter @dream/mobile test
cd apps/mobile && bunx expo start  # Metro, for a development build of the app
```

The app has native modules (dictation, Google Sign-In, the Live Activity module and widget), so it runs as a
development build rather than in Expo Go: build it once with `scripts/build-ios.sh simulator` on a Mac (Debug builds
load JavaScript from Metro: `CONFIGURATION=Debug DREAM_BACKEND=fixtures scripts/build-ios.sh simulator`), install the
`.app` in a Simulator, and rebuild only when native dependencies change.

Simulator and Debug builds (`build-ios.sh simulator`, `expo run:ios`) have over-the-air updates off, so Metro's
unsigned JavaScript loads and a published update can't replace the JavaScript under test. `DREAM_UPDATES_ENABLED=1`
turns them on for a build that should follow a channel (TestFlight builds always have them).

## Fixtures mode

With `DREAM_BACKEND=fixtures` the whole app works without a backend: the four sample projects, a connected ChatGPT
plan, Gmail. Answering, sending messages, connecting access, and creating projects all work; the simulated agent
acknowledges answers, replies, and asks a new project its first question (shown as a local notification).

Reach any state from a link, or from launch arguments in the Simulator (no taps needed):

```sh
xcrun simctl openurl booted "dream://project/prj_cabin?tab=chat&focus=msg_cabinrule"
xcrun simctl launch --terminate-running-process booted build.omer.dream \
  -dreamScenario signed-in,cabin-resolved -dreamRoute "/project/prj_cabin?tab=chat"
```

| Route | Screen |
| --- | --- |
| `/` | Home: the projects; one waiting for them has an amber dot and "Waiting for you" |
| `/project/prj_liftlog` · `prj_morningbrief` · `prj_cabin` · `prj_recipescaler` | Chat, with the Status card pinned under the header (Lift Log working, Cabin needing them) |
| `…?tab=status` | The Status card opened over Chat (the whole roadmap); `?tab=chat` folds it |
| `…?focus=<messageId>` · `…?land=<messageId>` | Expand a message; land on it in Chat, highlighted |
| `/new` · `/new?sample=long` · add `dictate=1` | New idea (the page), with a long brain dump, dictating at the cursor (simulated in the Simulator) |
| `/new?advanced=open` | New idea with its Advanced sheet open: the plan (with `two-plans`), the agent's model and effort, usage limits |
| `/new?starter=run-club-bot` | New idea filled with a starter's draft, the cursor after it. Ids are in `src/data/ideas.ts` |
| `/project/<id>?options=<messageId>&option=<n>` | A question's option previews full screen, at option n (from 0): `msg_cabinpick` (Cabin: phone screens, a desktop page, a recording), `msg_timersound` (Lift Log, after `options-sounds`: three sounds) |
| `/project/<id>?sheet=usage` | The usage sheet over the project (the ring in its header opens it): the week's ring with one line beside it, then rows for Limits, Agent, Plan (with `two-plans`) and Dream usage. `?sheet=limits`, `?sheet=agent`, `?sheet=plans` and `?sheet=costs` open one of its pages, `?sheet=plan` the Plan page asking to move it to the other plan, and `?sheet=adjust` (B's page, gone) the index |
| `/project/<id>?sheet=notifications` | The Notifications sheet: the project's apps that notify, their controls, what they sent (the bell opens it) |
| `/project/<id>?tab=chat&attach=sample` · `/new?attach=sample` | Chat's composer, or a new idea, with two photos and a PDF attached (uploading, then ready) |
| `/connect` · `/settings` | Subscription connect flow; Settings, the index of one-line rows (see "Settings" below) |
| `/plan/chatgpt` · `/plan/claude` | A plan's page: what's left of the week, each project's share, Reconnect and Remove; `/plan/claude` with `two-plans`; `?show=remove` opens the Remove warning |
| `/costs` · `/costs/everyone` | Dream usage, full screen (Settings' Dream usage row); everyone's, with `costs-operator` |
| `/service/<id>` · `?replace=1` | A connected service's page, with the paste field open: `int_google` (Gmail), and with `services` `int_openai` (a pasted key), `int_telegram` (a key file), `int_apple`; with `spotify-stopped` `int_spotify` (stopped working) |
| `/archived` · `/account` | Archived projects (Restore; swipe to delete), with `archived`; the account and Sign out |

Message ids: `msg_cabinrule`, `msg_cabinpick`, `msg_gcal` (Cabin), `msg_apple` (Lift Log), `msg_gmail` and
`msg_brieftelegram` (Morning Brief; the last-resort key file card), `msg_recipewho` (Recipe Scaler), `msg_spotify`
(Lift Log, after the `spotify-ask` scenario: an OAuth request for a provider other than Google), `msg_voicelong`
(Lift Log, after `long-question`: a whole message sent as the question, markdown and all), `msg_openai` (Lift Log,
after `vague-access`: a key request whose heading doesn't name the service, with how to get the key), `msg_voice` (Lift Log, after
`question-context`: the same decision as a short question with its context under it), and
`msg_unsupported` (Cabin, after `unsupported-message`: a kind of message this build can't decode, shown as the
neutral "update Dream" row).

Scenarios (`dream://fixtures/<name>?to=/path`, or `-dreamScenario a,b`): `signed-in`, `signed-out`, `reset`,
`paused` (Lift Log waits for a usage reset), `all-clear`, `cabin-resolved`, `withdraw-cabin`, `no-plan`,
`two-plans` (Claude connected next to ChatGPT, Morning Brief and Recipe Scaler on Claude: Settings lists both plans and New idea
the plan in Advanced), `plan-removed` (the same with Claude removed: those two wait for it, and Home says so; with `two-plans`,
`/plan/claude?show=remove` opens a plan's Remove warning, and `/new?advanced=open` the Advanced sheet with its plan switch),
`plan-moving`, `plan-moved` and `plan-move-failed` (after `two-plans`: Lift Log waiting to move from ChatGPT to Claude,
moved, or the move not working; the usage sheet's Plan row and page, and Chat's line, say so),
`services` (beside Gmail, a pasted OpenAI key, Morning Brief's Telegram key file and an App Store Connect key),
`week-unknown` (ChatGPT connected with no week known yet: "Connected", no ring), `plan-expired` and `plan-pending` (Claude's
sign-in expired, or still finishing, beside ChatGPT), `plan-limited` (ChatGPT paused until its five hours reset),
`plan-week-out` (ChatGPT's week ran out; after `usage-near-limit` and `two-plans`, the sheet offers Claude),
`live-activity`, `live-activity-needs` (start a Live Activity on the phone), `spotify-ask` (Lift Log asks to connect
Spotify), `spotify-stopped` (Lift Log's Spotify connection stopped working: its card says so and connects again),
`long-question`, `desktop-sent` and `desktop-opened` (Cabin's Google Calendar card, emailed to finish on a
computer, then opened there), `vague-access`, `question-context` (see the message ids above), `options-sounds` (Lift Log asks
which rest-timer sound to use, with the sounds to play),
`unsupported-message`, `now-two-lines` and `now-three-lines` (Lift Log's now sentence on two lines, and cut at two), `long-chat` (an afternoon of Lift Log messages to read back through: open
`/project/prj_liftlog?land=msg_long8` and the Status card folds to one line), `stall-next-write` (the next answer, message, new idea, key or decline hangs until the app
gives up after 25 s; the retry goes through), `live-slow` (each live connection takes 6 s to send its snapshot: a project
opened for the first time shows the waiting card, one opened before shows what it showed last and "Catching up"),
`live-down` (no live connection gets through: "Can’t reach Dream" after a few seconds; `reset` brings it back), `archived` (Recipe Scaler and Morning Brief are archived: off Home,
listed under Archived in Settings). `attachments-sent` adds a message to Lift Log with two photos and a PDF, and the agent's
reply. `no-projects` is a new person's Home: no projects and no app links, so the words and the drawn arrow lead to the input.

App links (Deck v3 option A, "Dock"): the row of app icons under Home's header. The sample world has four (three
made by agents, Cabin's still new with its dot, and Train times, which the person added back when the app let them).
`links-empty` shows the empty state, `links-new` adds a sixth and seventh so the row scrolls. Only agents make links,
so the add sheet offers the agents' links they took off Home: `links-removed` gives it two (Brief and Lift Log's
Rest timer), and `links-nothing-published` leaves only Train times, so it explains that nothing's been made yet
(with the sample world as is, it says everything is on Home already). `/?sheet=add` opens the add sheet; with launch
arguments, `-dreamRoute "/?sheet=icon&link=lnk_traintimes"` and `"/?sheet=home-screen&link=lnk_cabin"` open Change
icon and Add to Home Screen. Holding an icon opens its context menu (Open, Share, Add to Home Screen, Rename, Change
icon, Remove); Share is React Native's `Share`, iOS's share sheet with the link and its name. There's no photo
picker in this build, so the person's icons are an SF Symbol or an emoji on one of ten colours; Add to Home Screen
draws the tile as a png (react-native-svg's `toDataURL`) for the gateway to serve as the touch icon, and as the
link preview's image when the page has none.

Notifications from a project's apps (`dream notify`): an app asks once, with a `Notifications` access card in Chat
(Allow, or Not now with the decline sheet's reasons), and then notifies under its own name in the `app` category,
whose actions are Mute for today and Turn off this app. A tap opens the notification's page full screen inside
Dream, or the project's Notifications sheet when it has none; the bell in the project's header opens the sheet once
one of its apps has asked. Morning Brief's digest app is allowed in the sample world, with three notifications in its
history (`msg_briefnotify` is its card). `notify-ask` has Lift Log's app ask (`msg_liftnotify`), and `notify-app`
delivers a Morning Brief digest as a local notification, as APNs would.

Holding a project on Home opens iOS's context menu (expo-router's `Link.Menu`) with Archive and Delete. Archive
takes it off Home at once with Undo in the toast; Settings lists archived projects with Restore and Delete. Delete
asks first and has no Undo.

The agent's presence (Deck v3 "A+B+C": the row at the bottom of Chat, the dot and state line in the header and on
Home, the receipt under their latest message) follows the mock's scenario, a new question in Lift
Log (`msg_askrest`, reply `msg_replyrest`): `activity-sent` (Sent, typing dots, "Asleep · waking up"),
`activity-starting` ("Starting its computer…", Seen), `activity-working` ("Working · 2m"), `activity-done` (the
reply, "Done for now", a green dot), `activity-home` (Home with every state: done, done for now until 6:55 AM, waiting
for you, paused until 4 PM), and `activity-new-idea` (a new idea's first half-minute, at
`/project/prj_newidea?tab=chat`). Without a scenario, Lift Log is working, Cabin is awake and Morning Brief sleeps
until 6:55 AM; a message to any project goes through Sent, then Seen as delivery begins (with "starting" if it was asleep), working, then the
reply and "Done for now". "Done for now" means the agent finished what it was doing and nothing of it is running (a
turn lasts while its background work does, so that's still Working); the header and Chat say it alike whether its
computer is up or asleep, which only the dot shows, with when it wakes next if it's scheduled. "Asleep" is said only
before a project's first turn has ended.

Workstreams (mocks/screens/workstreams, option A): while two or more of a project's workstreams are active, the
Status card shows a row for each in place of the "now" sentence, a row waiting on them in amber at the top, the rest
summed up past three, and what finished lately folded into one line; messages carry their workstream's label.
Tapping a row puts its tag on the composer and dims the other messages; what they send goes to that workstream
(replying to one of its messages, in that message's thread, does too). `workstreams` puts Lift Log in A1 (three rows, the Health import
folded), `workstreams-waiting` in A2 (the rest timer waits on `msg_wssound`), `workstreams-many` runs five, and
`workstreams-one` leaves one active, which looks like a project without any. `?work=ws_android` opens the project
writing to that workstream (A3):

```sh
xcrun simctl launch --terminate-running-process booted build.omer.dream \
  -dreamScenario signed-in,workstreams -dreamRoute "/project/prj_liftlog?tab=chat&work=ws_android"
```

Threads (mocks/screens/replies, direction B): holding any message brings up its menu (Reply, Copy, and a card's
Open and Don't connect); Reply, a swipe to the right, or the line a thread folds into ("2 replies · Dream: …")
opens the thread over Chat, where a card can still be answered, and the expanded question and access views and the
option viewer have a Reply button too. `threads` gives Lift Log a thread on the Health import update (its last
reply also shows where it fell), the rest timer question changed in its thread (`msg_thsound`, "Changed"), one on
their own message (`msg_thskip`), and one on the Apple key request (`msg_apple`). `?thread=<messageId>` opens a
thread (`&compose=1` with the keyboard up) and `?hold=<messageId>` holds a message. In fixtures, replying in an open
question's thread has the agent add the reply as its first option.

```sh
xcrun simctl launch --terminate-running-process booted build.omer.dream \
  -dreamScenario signed-in,threads -dreamRoute "/project/prj_liftlog?tab=chat&thread=msg_thsound"
```

Answering moves on: `ask-series` gives Cabin three open questions and the calendar request (`msg_cabinrule`,
`msg_cabinpick`, `msg_gcal`, `msg_cabinhold`). Answering one expanded goes to the project's next open ask after a
beat; answering a card inline in Chat scrolls to the next open card below it.

Declining with a reason: "Don't connect" on an access card or its expanded view opens "Why not?" (one-tap reasons,
or their own words, typed or dictated). `/project/prj_cabin?decline=msg_gcal` opens it for Cabin's calendar
request; `declined-reason` shows that request declined with a reason.

```sh
xcrun simctl launch --terminate-running-process booted build.omer.dream \
  -dreamScenario signed-in,activity-working -dreamRoute "/project/prj_liftlog?tab=chat"
```

Project usage (Deck v3 option A, the ring): the right of the project header has a ring of the subscription's week,
this project's share in white over everything else in grey, with "4%" over "of week"; tapping it opens the usage
sheet (`…?sheet=usage`; usage sheet direction A, "Index", mocks/screens/usage-sheet-directions). It shows the week as
a ring with this project's share in it and one line beside it ("62% of your week is left." over when it resets),
then rows laid out like Settings: Limits ("None", "Up to 25%"), Agent (the model), Plan (with both plans connected,
or a move to speak of) and, under Dream usage, this month so far. Each row opens a page of its own in the sheet:
the two limits ("This project may use up to N% of the week", "Stop when the plan has N% left", saved as each field
loses focus); the agent's model and effort; both plans with what's left of each and the move between them (asking
first); and the lines Dream paid for. By default the sample world's ChatGPT Pro week is 38% used, Lift Log about 4%
of it, and each of the simulated agent's turns adds a little (the header follows `ProjectEvent.Usage`).
`usage-near-limit` is the heavy week: 92% used, the ring's arc and "8% left" in amber, and the sheet's line in amber
saying what happens if it runs out; with `two-plans`, the Plan row says how much of Claude's week is left.
`usage-limit` gives Lift Log a limit at its share, so it's paused by it: "Paused · at its 4% limit" in the header,
"paused" under the ring, the sheet's line and Limits row in amber, and Clear the limit on the Limits page.
`plan-limited` with `paused` is the plan's own pause: the five hours ran out, so the line says until when (the five
hours show only then), and `plan-week-out` the same for the week. `usage-none` is a world where no usage is known:
the header shows nothing, and the sheet has no ring. `usage-deleted` adds two deleted projects' shares to the plan's
week. `usage-normal` goes back to the default. `screenshots/usage-sheet-a/` has each of the sheet's states and pages
from the Simulator.

Settings (direction B, mocks/screens/settings-directions; `data/settings.ts` says what every row and page says,
`ui/Group.tsx` draws them) is an index of one-line rows, each with its answer on the right, and every row opens a
page built the same way: the figure, the list, the actions. Subscription usage lists each plan with what's left of
its week and a small ring (their projects in white, the rest in grey), "Connected" with no ring while Dream hasn't
seen the week, "Paused until …", or a sign-in finishing or expired; a plan that isn't connected has a dashed tile in a
row's shape to add it. Its page, `/plan/<provider>`, has what's left in large type, when it resets, the week's bar
with what its two parts are, the five hours, each project's share (deleted projects together, Outside Dream's), and
Reconnect and Remove (Remove says first what it does to the projects on it). Its shares come from `GetAccountUsage`;
against an API without it the page shows the connection's own windows and no shares. Near the limit
(`usage-near-limit`) the row, its group and the page turn amber with a line on what happens if the week runs out,
and Home's profile button gets an amber dot, only then. Dream usage is this month so far, opening `/costs` (below).
Connected services say who can use each (all projects, or one for a key file) or that it stopped working, and each
opens `/service/<id>`: what it is and since when, who can use it in a sentence (a key file links to its project),
Replace for a pasted key or key file, and Disconnect (Remove, for a key file), which asks first. Archived projects
and the account open their own pages; a restart when an update waits, and the version, come last.

```sh
xcrun simctl launch --terminate-running-process booted build.omer.dream \
  -dreamScenario signed-in,usage-near-limit -dreamRoute "/project/prj_liftlog?sheet=usage"
```

What Dream pays to run their projects (docs/metering.md, `ui/Costs.tsx`, `data/costs.ts`) is dollars, not the
plan's percentages, and never shares a total or a row with them. The usage sheet has a Dream usage row with
this month so far, which opens a page with the total, last month beside it, and a line for each thing it paid for
(machine time, cloud browsers, Macs, OpenAI with its models, storage, email). Settings has a Dream usage row under the plans (this
month so far) that opens `/costs`: the 30 days (touch a bar
to read the day), what it paid for with OpenAI by model, each project largest first (tapping one
opens its usage sheet; archived ones say so, deleted ones are one row, sign-ins are Outside your projects). An
operator (`costs-operator`) also gets "Everyone on this Dream" at the foot, which opens `/costs/everyone`: each
person's month and the overhead no one caused. `costs-none` is before anything cost anything (no Dream usage row in
the sheet; `costs-machine` is a month where each project only ran its computer, 2.5 hours; Settings' row says "Nothing yet" and opens nothing); `costs-normal` goes back to the default. Against an API without
the cost RPCs, nothing shows. `screenshots/costs/` has each state from the Simulator, and `screenshots/settings-b/` Settings
and its pages.

```sh
xcrun simctl launch --terminate-running-process booted build.omer.dream \
  -dreamScenario signed-in,costs-operator -dreamRoute "/costs"
```

## Checking against a deployed API

`scripts/check-live.ts` runs the app's data layer (the services the screens use) from Node against the API: it
reads what Home reads, registers a test device, asks which notifications are stale, and subscribes to a project's
live socket if there is one.

```sh
DREAM_SESSION=$(node infra/scripts/dev-login.ts session you@example.com) node apps/mobile/scripts/check-live.ts
```

`screenshots/` holds the last Simulator run of every screen and the main flows (fixtures mode);
`screenshots/live/` holds a run against the deployed API with real agent projects (a development build with
`DREAM_BACKEND=live`, signed in through the dev secret).

Screens are checked on a Namespace Mac: Outerloop's own Simulator carries only Expo Go, which can't run this app.

To drive the live app in a Simulator, build the development app (`CONFIGURATION=Debug DREAM_BACKEND=live
scripts/build-ios.sh simulator`), install it, run `DREAM_BACKEND=live bunx expo start --dev-client` next to the
Simulator, and open `dream://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081`. Expo SDK 58 needs Xcode
26.4 or newer: on 26.3 `expo-modules-jsi` fails one Swift 6 check. On Namespace, create the Mac with
`macos.version=27.x` (macOS 27.2 with Xcode 26.6, 27.0, 27.1 and 27.2); `build-ios.sh` picks Xcode 26.6 there and
builds unchanged. The `26.x` image stops at Xcode 26.3. In November 2026 a fresh checkout built for the Simulator
(Release) in about 7 minutes, and an unsigned device archive in about 4.

## Crash and error reports

`src/platform/errorReporting.ts` reports uncaught JS errors (React Native's global handler), unhandled promise
rejections (release builds) and screens that fail to render (`ui/ErrorBoundary.tsx`: `ScreenBoundary` around the
navigator, `LayerBoundary` around each layer over it, which closes that layer rather than ending the app) to the
Worker's `POST /client-errors`, with the stack, the route without its query, and the build and update. A fatal one is
kept on disk and sent on the next launch if it didn't make it. Live builds send; fixtures builds only log. Read them
with `curl -H "x-dream-dev-secret: …" https://dream.omer.build/admin/client-errors`. An exception inside a worklet
(an animation callback on the UI runtime) aborts the app natively before any of this runs; those show up only in
TestFlight's crash reports, so worklets hand work back with `scheduleOnRN(fn)` where `fn` is made on the React side
(`test/worklets.test.ts`).

## Building for TestFlight

```sh
DREAM_APPLE_TEAM_ID=… DREAM_GOOGLE_IOS_CLIENT_ID=… \
  scripts/build-ios.sh testflight --asc-key-path AuthKey_ABC123.p8 --asc-key-id ABC123 --asc-issuer-id <uuid>
```

It archives with automatic signing (Xcode registers the App IDs for the app and the widget, and their profiles,
through the App Store Connect key) and uploads the build to App Store Connect. `ASC_EXPORT_ONLY=1` stops at a signed `.ipa` in `build/export`.

Without a Mac, `scripts/testflight-namespace.ts` (run from the repo root) does the same on a Namespace Mac. The
key is the Worker secret `ASC_TESTFLIGHT_KEY_P8` (see `docs/setup/testflight.md`), released only to that Mac,
encrypted to a key it generated (`apps/api/src/http/Testflight.ts`); it never touches the machine running the
script. `check` verifies the key on a fresh Mac in about a minute; `testflight [--no-upload]` ships
`git archive HEAD`, runs `build-ios.sh testflight` there, then destroys the Mac.

## Over-the-air updates

JavaScript-only changes reach installed builds without a new TestFlight build. The app runs stock `expo-updates`
with standard config only (`app.config.ts`): `updates.url`, `runtimeVersion: { policy: "fingerprint" }`,
`codeSigningCertificate` with `codeSigningMetadata` (`keyid: "main"`, `rsa-v1_5-sha256`), and the channel in the
standard `expo-channel-name` request header. The server is Dream's Worker (`apps/api/src/http/Updates.ts`), which
implements the [Expo Updates protocol v1](https://docs.expo.dev/technical-specs/expo-updates-1/) and nothing else:
`GET /updates/manifest` (a signed manifest, a signed `rollBackToEmbedded` directive, or 204) and
`GET /updates/assets/:hash`, with bundles and assets in the `dream-updates` R2 bucket.

**When an update takes over.** expo-updates checks on every launch without holding the launch up
(`fallbackToCacheTimeout: 0`) and downloads in the background; the update runs from the next launch. The app also
looks again when it comes back after a minute or more in the background, and restarts on a downloaded update when
it comes back after 15 minutes or more (the screen it returns to is stale by then). Nothing interrupts someone using the app. Settings shows which update is running under the version, and
"Restart to update Dream" once one is downloaded. So to see a fix right away: open Dream, wait a few seconds, open
Settings and tap Restart (or close Dream and open it again).

**Compatibility.** The runtime version is a fingerprint of everything that makes the native app
(`fingerprint.config.js`): native modules and their versions, config plugins, the app config, the certificate.
Version, build number and `extra` are left out, so TestFlight builds with the same native code share a runtime
version and JS-only config changes ship as updates. An update reaches only builds of its runtime version, so it
can't land on a build missing a native module it needs. `EXPO_UPDATES_WORKFLOW_OVERRIDE=managed` (in
`build-env.sh`) keeps the fingerprint the same on the build Mac (a `git archive` checkout) and wherever you
publish. The Worker records what each runtime version's builds last asked with, and `publish` refuses a runtime
version no build on the channel has asked with (`--force` overrides): if native code changed since the last build,
the update would reach no one, and you need a TestFlight build instead.

**Channels.** `production`: TestFlight builds (`build-ios.sh testflight`). `development`: other builds against the
live API. `fixtures`: builds with the sample world. Only TestFlight builds take updates by default; others follow
their channel when built with `DREAM_UPDATES_ENABLED=1`. A build follows the channel `build-env.sh` gives it
(`DREAM_UPDATES_CHANNEL` overrides), and `publish --channel` names the one to publish to (default `production`).
Only `production` insists on main as pushed to origin, so test publishes go to another channel and can't reach the
founder's phone.

**Signing.** The Worker generates the RSA key itself (`updates.ts init`) and stores it sealed with
`DREAM_ENCRYPTION_KEY` in D1 (`update_signing_key`), so the private key never exists outside the Worker: not in
the repo, a dev machine, a log, or a Worker secret anyone could read. It signs each manifest and directive as it
serves it. The certificate (public) is committed at `certs/updates-certificate.pem`; every build embeds it and
refuses updates that are unsigned or signed by another key, and checks each asset's SHA-256 from the signed
manifest. The key is never replaced (builds out there trust only it).

**Who can publish.** The routes that upload, publish and roll back need `UPDATES_PUBLISH_SECRET` in
`x-dream-updates-secret`. It's a Worker secret with a copy in the operator's D1 `dream-ops`
(`infra/scripts/updates-secret.ts`), which `updates.ts` reads with the workspace's Cloudflare connection. It isn't
`DEV_LOGIN_SECRET`, and project sandboxes never get either, so an agent in a sandbox can't publish. The Worker
only signs updates whose assets it hash-checked on upload.

### Setting up (once)

From the repo root on main, after the branch that adds this is merged:

1. `bun run infra:deploy` (adds the `dream-updates` bucket, migration 0006 and the routes).
2. `node infra/scripts/updates-secret.ts ensure` (generates `UPDATES_PUBLISH_SECRET`).
3. `node apps/mobile/scripts/updates.ts init`, then commit and push `apps/mobile/certs/updates-certificate.pem`.
4. A TestFlight build (`node apps/mobile/scripts/testflight-namespace.ts testflight`). It's the baseline: builds
   from before it have no expo-updates, so they never update. `build-ios.sh testflight` refuses to build without
   the certificate.
5. Open that build once on the phone. It checks in, and from then on `publish` targets it.

### Publishing, rolling back, what's live

```sh
node apps/mobile/scripts/updates.ts publish                      # the committed app, to production builds
node apps/mobile/scripts/updates.ts publish --message "Fix the composer"
node apps/mobile/scripts/updates.ts status                       # per runtime version: live, history, last check-in
node apps/mobile/scripts/updates.ts rollback                     # the update before the live one, again
node apps/mobile/scripts/updates.ts rollback --to <update id>    # a named one (also rolls forward)
node apps/mobile/scripts/updates.ts rollback --to embedded       # the bundle inside the build
node apps/mobile/scripts/updates.ts publish --channel development
```

`publish` refuses uncommitted changes, exports with `expo export` under the channel's build config (about a
minute), uploads only files the Worker doesn't have, and makes the update live. A rollback publishes the earlier
update again under a new id, since expo-updates only moves to newer updates; rolling back past the first update
sends `rollBackToEmbedded`. `status` shows, per runtime version, when a build last asked and which update it was
running, so you can see the phone pick an update up. When native code changes (a new native module, a config
plugin, an Expo upgrade), `publish` says no build has the new runtime version: ship a TestFlight build.

### Checking it without a phone

`apps/api/scripts/updates-dev-server.ts` runs the Worker's update routes locally (the real handlers over the
test D1 and R2), and can serve unsigned, wrongly signed, tampered or wrong-runtime manifests to check that the app
refuses them. Expose it (`ol expose 8787`), `init` with `DREAM_UPDATES_CERTIFICATE=certs/test/updates-certificate.pem`
(gitignored), build a Release Simulator app with `DREAM_UPDATES_ENABLED=1`, `DREAM_UPDATES_URL` and that certificate, and publish to the
`fixtures` channel with `DREAM_API_URL` and `DREAM_UPDATES_SECRET` pointing at it. See its header.

## Switching to EAS Update

The client side is stock, so moving to Expo's hosted service is a checklist:

1. `eas init` and `eas update:configure`: they set `updates.url` to `https://u.expo.dev/<project id>` and
   `extra.eas.projectId`. Remove `DREAM_UPDATES_URL` and the Worker URL from `app.config.ts`.
2. Create EAS channels named like ours (`production`, `development`, `fixtures`), each pointing at a branch. The
   `expo-channel-name` header and the fingerprint runtime version policy stay as they are.
3. A new certificate: Dream's key never leaves the Worker, so EAS can't sign with it.
   `npx expo-updates codesigning:generate` makes a key and certificate; `eas update --private-key-path` signs
   with it, so the key lives wherever you publish from. Replace `certs/updates-certificate.pem` (keep keyid
   `main`, or change `codeSigningMetadata`).
4. One native build: a new URL and certificate change the runtime version, so the next TestFlight build is the
   new baseline; builds from before it keep following the Worker until they're replaced.
5. Publish with `eas update --channel production` instead of `updates.ts publish`, roll back with
   `eas update:rollback`. Then the Worker's update routes, the `dream-updates` bucket and
   `UPDATES_PUBLISH_SECRET` can go once no build uses them (`updates.ts status` shows their last check-ins).
