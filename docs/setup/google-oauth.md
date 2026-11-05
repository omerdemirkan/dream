# Google OAuth clients

**Why:** two things.

- **Sign in with Google** in the app. The dev secret works meanwhile.
- Agents asking for Gmail, Calendar, Drive and so on with `dream access google`. Until this is set up, those cards
  can't connect.

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
   100-user cap stays. That's fine for you and friends.

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

**Tell me:** that it's done. I'll check a `dream access google` card end to end with my own throwaway Google account,
not yours.
