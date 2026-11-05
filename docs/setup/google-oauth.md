# Google OAuth clients

**Why:** two things.

- **Sign in with Google** in the app. The dev secret works meanwhile.
- Agents asking for Gmail, Calendar, Drive and so on with `dream access google`. Until this is set up, those cards
  can't connect.

**Before your Apple account is approved** you can do everything except step 4. The web client (steps 1–3, 5, 6)
is what agents' Gmail/Calendar/Drive cards use, and it doesn't involve Apple. Step 4, the iOS client for "Sign in with
Google", needs the bundle id, so it waits; until then you sign in with the dev secret. When you add the iOS client
later, put both ids in `GOOGLE_IOS_CLIENT_ID` as described in step 6.

**1. A Google Cloud project**

console.cloud.google.com → project picker → **New project** → name "Dream" → **Create**, then select it.

**2. Consent screen**

1. **APIs & Services** → **OAuth consent screen** (or **Google Auth Platform** → **Branding**).
2. App name "Dream", your email as the support and developer contact.
3. **Audience: External**.
4. **Test users**: add yourself and each friend's Google account. The cap is 100.
5. **Publishing status**: in **Testing**, Google expires refresh tokens after **7 days**, so Gmail and Calendar
   connections would die weekly. Click **Publish app** to move to **In production**. Google won't review it unless
   you submit it. People then see a "Google hasn't verified this app" screen once (Advanced → Go to Dream), and the
   100-user cap stays. That's fine for you and friends. Google first wants a home page, a privacy policy and a
   verified domain on the Branding page: [google-publish.md](google-publish.md) walks through it.

**3. The web client (integrations)**

1. **APIs & Services** → **Credentials** → **+ Create credentials** → **OAuth client ID**.
2. Type **Web application**, name "Dream API".
3. **Authorized redirect URIs**: `https://dream.omer.build/oauth/google/callback`
4. **Create**. Copy the **Client ID** and the **Client secret**.

**4. The iOS client (sign-in)**

1. **+ Create credentials** → **OAuth client ID** → type **iOS**, name "Dream iOS".
2. **Bundle ID**: the app's bundle id from [apple-developer.md](apple-developer.md).
3. **Create**. Copy the **Client ID**. There's no secret.

**5. Turn on the APIs agents will use**

**APIs & Services** → **Library**. Enable at least **Gmail API**, **Google Calendar API**, **Google Drive API**,
**Google Sheets API** and **People API**. Any other Google API an agent needs has to be enabled the same way, or its
calls fail with "API not enabled".

**6. Worker secrets** (see [README.md](README.md))

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | the web client's Client ID |
| `GOOGLE_CLIENT_SECRET` | the web client's Client secret |
| `GOOGLE_IOS_CLIENT_ID` | `<iOS client id>,<web client id>`: both, comma-separated, so sign-in works either way the app is built |

**7. The app build:** pass `DREAM_GOOGLE_IOS_CLIENT_ID=<iOS client id>` to the TestFlight build
([testflight.md](testflight.md)). If you set it up after building, run the build again.

**Tell me:** that it's done. I'll check that a `dream access google` card leads to Google's consent page with the
right client and redirect. I don't have a Google account of my own, so the first real consent will be yours (or a
friend's).
