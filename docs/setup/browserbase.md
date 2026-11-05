# Browserbase (the cloud browser)

**Why:** `dream browser` gives agents a real, recorded Chrome. They use it for sites that block headless browsers, for
logging in somewhere on your behalf, and for recordings they can show you. The account is on the free plan and its
browser minutes are used up, so every start fails with "HTTP 402: Free plan browser minutes limit reached". Agents
fall back to the local headless Chromium, which covers screenshots and simple pages.

**Steps**

1. browserbase.com → sign in → **Settings** → **Plans & Billing** (or browserbase.com/plans).
2. Choose **Developer** (includes browser hours each month, plus pay-as-you-go beyond them). Pick a bigger plan only
   if you expect agents to run long browser sessions daily.
3. The API key and project id don't change when you upgrade, so nothing else is needed.

If you ever create a new key: set the Worker secret `BROWSERBASE_API_KEY` to it (see [README.md](README.md)). If the
project changes, set `BROWSERBASE_PROJECT_ID` too.

**Tell me:** when it's upgraded. I'll run `dream browser` from a sandbox to confirm.
