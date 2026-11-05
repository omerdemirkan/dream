# @dream/mobile

Dream's iPhone app: Expo SDK 58 (React Native 0.88), expo-router, Effect 4.1 with `@effect/atom-react`. The design
is Deck v3 (`mocks/deck-v3.html`); the one change is that "Something else…" (typed or dictated) lives only in the
expanded view.

## Layout

| Path | What |
| --- | --- |
| `src/app` | Routes: Home (`index`), `project/[id]` (Status / Chat), `new`, `sign-in`, `connect`, `settings`, `oauth/google`, `fixtures/[scenario]` |
| `src/data` | Services (no React Native): `AppClient` (AppRpcs over HTTP), `LiveProjects` (ProjectLiveRpcs over WebSocket, re-subscribing with a fresh ticket), `ProjectStates`, `Answers` (Undo), `Session`, formatting |
| `src/fake` | The fixtures backend: `AppRpcs` handlers and live events over the Deck v3 sample world, with a small simulated agent |
| `src/state` | The atom runtime and the atoms screens use |
| `src/platform` | Expo/iOS pieces: keychain, streaming fetch, push, dictation, Google Sign-In |
| `src/ui` | Components: the deck, Status roadmap, Chat messages, the expanded view and its grow/shrink animation |
| `modules/dream-native` | Local Expo module (Swift): Live Activity push-to-start and update tokens, launch arguments |
| `targets/widget` | The Live Activity widget (lock screen + Dynamic Island), via `@bacons/apple-targets` |
| `scripts/build-ios.sh` | `expo prebuild` + CocoaPods + `xcodebuild`, for the Simulator or TestFlight |

## Configuration

`app.config.ts` reads these at build time (`expo prebuild`, `expo start`):

| Variable | Default | |
| --- | --- | --- |
| `DREAM_BACKEND` | `fixtures` | `fixtures` runs against the in-app fake; `live` talks to the API |
| `DREAM_API_URL` | `https://dream.omer.build` | RPC at `/rpc`, live sockets via `GetLiveUrl`, media at `/media/:id` |
| `DREAM_BUNDLE_ID` | `com.omer.dream` | placeholder until the founder confirms |
| `DREAM_APPLE_TEAM_ID` | — | needed to sign the app and the widget |
| `DREAM_GOOGLE_IOS_CLIENT_ID` | — | enables native Google Sign-In (adds its URL scheme) |
| `DREAM_GOOGLE_WEB_CLIENT_ID` | — | optional: Google's ID token audience becomes the web client |
| `DREAM_APS_ENVIRONMENT` | `development` | APNs entitlement; the TestFlight build uses `production` |

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

## Fixtures mode

With `DREAM_BACKEND=fixtures` the whole app works without a backend: the four sample projects, a connected ChatGPT
plan, Gmail. Answering, sending messages, connecting access, and creating projects all work; the simulated agent
acknowledges answers, replies, and asks a new project its first question (shown as a local notification).

Reach any state from a link, or from launch arguments in the Simulator (no taps needed):

```sh
xcrun simctl openurl booted "dream://project/prj_cabin?tab=chat&focus=msg_cabinrule"
xcrun simctl launch --terminate-running-process booted com.omer.dream \
  -dreamScenario signed-in,cabin-resolved -dreamRoute "/project/prj_cabin?tab=chat"
```

| Route | Screen |
| --- | --- |
| `/` | Home: the needs-you deck, then projects |
| `/project/prj_liftlog` · `prj_morningbrief` · `prj_cabin` · `prj_recipescaler` | Status |
| `…?tab=chat` | Chat; add `&focus=<messageId>` to expand a message, `&land=<messageId>` to land on it highlighted |
| `/new` · `/new?dictate=1` | New idea, optionally dictating |
| `/connect` · `/settings` | Subscription connect flow; settings |

Message ids: `msg_cabinrule`, `msg_cabinpick`, `msg_gcal` (Cabin), `msg_apple` (Lift Log), `msg_gmail` (Morning
Brief), `msg_recipewho` (Recipe Scaler).

Scenarios (`dream://fixtures/<name>?to=/path`, or `-dreamScenario a,b`): `signed-in`, `signed-out`, `reset`,
`paused` (Lift Log waits for a usage reset), `all-clear`, `cabin-resolved`, `withdraw-cabin`, `no-plan`,
`live-activity`, `live-activity-needs` (start a Live Activity on the phone).

## Building for TestFlight

```sh
DREAM_APPLE_TEAM_ID=… DREAM_GOOGLE_IOS_CLIENT_ID=… \
  scripts/build-ios.sh testflight --asc-key-path AuthKey_ABC123.p8 --asc-key-id ABC123 --asc-issuer-id <uuid>
```

It archives with automatic signing (Xcode registers the App IDs for the app and the widget, and their profiles,
through the App Store Connect key) and uploads the build to App Store Connect.
