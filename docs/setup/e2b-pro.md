# E2B Pro (optional)

**Why:** on the Hobby plan, E2B stops any sandbox that has run for an hour straight. Dream works around it: during a
turn it pauses and resumes the sandbox just before the hour, and I verified that a paused turn carries on. Still,
each cycle freezes the agent for a few seconds and drops open network connections (a long build download, say). Pro
raises the limit to 24 hours.

**Steps**

1. e2b.dev → dashboard → **Billing** (or **Team settings** → **Plan**) → upgrade to **Pro**.
2. Set the Worker secret `E2B_SANDBOX_MAX_RUN` to `24 hours` (see [README.md](README.md)). The value is an Effect
   duration string; leaving it unset means `1 hour`.

The API key stays the same, so nothing else changes.

**Tell me:** nothing needed. If you upgrade but don't set the secret, Dream keeps cycling hourly, which is harmless,
just unnecessary.
