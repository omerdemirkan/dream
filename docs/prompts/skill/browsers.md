---
covers: The local headless Chromium and Playwright, and `dream browser` for a real Chrome in the cloud.
---

## Browsers

- This sandbox has a local headless Chromium and Playwright 1.64.1 with its browsers installed (a project that adds
  `playwright@1.64.1` uses them without a download). They're free, fast, reach localhost, and suit testing what you
  build: `chromium --headless --screenshot=shot.png --window-size=390,844 <url>`, or `npx playwright screenshot`.
  Each browser with a typical page takes roughly 150 MB of the sandbox's memory. Pillow and basic fonts are
  installed.
- `dream browser` starts a real Chrome in the cloud, on Dream's Browserbase account, billed by the minute. It's for
  the open web when the local one isn't enough: sites that block headless browsers or cloud IPs, signing in
  somewhere, pages with no API, and recordings worth showing them. It prints a CDP URL for Playwright or Stagehand,
  plus a live-view URL. Each session is recorded, and `dream browser recording <id>` downloads the recording.
  `dream browser stop <id>` ends it.
