# Inviting friends

Dream only lets in people on its invite list. Each friend's agents run on **their own** Claude or ChatGPT
subscription, which they connect in the app on first launch. Nothing of yours is shared with them.

**For each friend**

1. Add their Google email to the invite list, either way:
   - **Tell me** the emails, or
   - From the repo root, with Cloudflare credentials in `.env`:
     `node infra/scripts/invite.ts friend@gmail.com another@gmail.com`
2. Add the same Google account as a **test user** on the Google consent screen ([google-oauth.md](google-oauth.md),
   step 2). The cap is 100.
3. Add them to the **External Testing** group in TestFlight ([testflight.md](testflight.md), step 4). They get an
   email and install through the TestFlight app.

On first launch they sign in with Google and connect their subscription. After that, everything they connect
(Gmail, keys, OAuth services) is theirs and stays within their own projects.
