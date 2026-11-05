# Publishing Dream's Google consent screen

**Why:** while the consent screen (Google Cloud project `dream-513815`) is in **Testing**, Google expires refresh
tokens after 7 days, so everyone's Gmail and Calendar connections die weekly. **In production** they don't. Google
won't let you publish until the Branding page has a home page, a privacy policy and a verified authorized domain.

**Before you start:** the two pages have to be live, so check that https://dream.omer.build/ and
https://dream.omer.build/privacy open (I'll tell you once they're deployed). Use the Google account that owns the
Cloud project for every step below, so Search Console's verification counts for the project.

**1. Branding page**

console.cloud.google.com → project **dream-513815** → **Google Auth Platform** → **Branding**.

| Field | Value |
| --- | --- |
| App name | `Dream` |
| User support email | `omerfarukpiano@gmail.com` |
| App logo | leave empty (a logo makes Google require brand verification first) |
| Application home page | `https://dream.omer.build/` |
| Application privacy policy link | `https://dream.omer.build/privacy` |
| Application terms of service link | leave empty |
| Authorized domains | `omer.build` |
| Developer contact information | `omerfarukpiano@gmail.com` |

**Save**. If Google says `omer.build` isn't verified yet, do step 2 and come back.

**2. Verify omer.build in Search Console**

1. Open https://search.google.com/search-console → **Add property**.
2. Pick **Domain** (the left box, not URL prefix) and enter `omer.build` → **Continue**.
3. Google shows a TXT record, `google-site-verification=…`. **Copy the whole value and send it to me. Don't click
   Verify yet.** The handoff: I add it as a TXT record on `omer.build` through Cloudflare's API and tell you when
   it's in.
4. Click **Verify**. If Google says it can't find the record, wait a few minutes and try again. Leave the record
   in place afterwards; Google checks it again from time to time.

**3. Publish**

1. Back on **Branding**, check that `omer.build` is accepted under Authorized domains and **Save**.
2. **Google Auth Platform** → **Audience** → **Publish app** → **Confirm**. The status should read **In production**.
3. Don't submit for verification. Gmail scopes are "restricted", and full verification needs a paid security
   assessment. Unverified, people see "Google hasn't verified this app" once (Advanced → Go to Dream), and the
   100-user cap stays. That's fine for you and friends.

Connections made while the app was in Testing keep their 7-day expiry. After publishing, reconnect Google from
those cards once, and the new connections last.

**Something the policy commits you to:** the privacy policy says that if someone emails asking to delete their
account or a project, it's deleted within 30 days and they get a confirmation email. There's no button for that in
the app yet, so forward any such email to me and I'll do the deletion.

**Tell me:** the TXT value (step 2), and later that the status reads In production.
