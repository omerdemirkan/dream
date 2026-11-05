# What Dream needs from you

One file per item. They're in the order I'd do them. Each one ends with what to tell me, if anything.

| # | File | Unlocks | Time |
| --- | --- | --- | --- |
| 1 | [r2.md](r2.md) | Screenshots and recordings in Chat — **done 2026-11-05** | 5 min |
| 2 | [apple-developer.md](apple-developer.md) | Signing the app; everything below that touches Apple | 15 min |
| 3 | [apns.md](apns.md) | Push notifications and Live Activities | 10 min |
| 4 | [testflight.md](testflight.md) | Dream on your phone (and your friends') | 30–60 min, needs a Mac with Xcode 26.4+ |
| 5 | [google-oauth.md](google-oauth.md) | Sign in with Google; agents using Gmail, Calendar, Drive | 20 min |
| 6 | [oauth-providers.md](oauth-providers.md) | Agents connecting Spotify, GitHub, Strava, Dropbox, Slack, Notion (being built now) | 5 min per provider |
| 7 | [browserbase.md](browserbase.md) | The cloud browser (`dream browser`) | 5 min |
| 8 | [claude-token.md](claude-token.md) | Optional: rotating the Claude token I partly printed into my log | 5 min |
| 9 | [e2b-pro.md](e2b-pro.md) | Optional: sandboxes that run 24 h straight instead of 1 h | 5 min |
| 10 | [invite-friends.md](invite-friends.md) | Letting friends sign in | 1 min each |

## Setting a Worker secret (used by several files)

Values that Dream's Worker reads go in as **secrets**, even ones that aren't secret (client ids, team ids), because
plain variables are wiped by every deploy and secrets aren't.

1. Cloudflare dashboard → **Workers & Pages** → **dream-api** → **Settings** → **Variables and Secrets**.
2. **+ Add** → Type **Secret** → the name exactly as written in the file → paste the value → **Deploy**.

The Worker picks secrets up immediately; no redeploy is needed. `node infra/scripts/ensure-secrets.ts` (run from the
repo root) lists which expected secrets are still missing, without printing any values.
