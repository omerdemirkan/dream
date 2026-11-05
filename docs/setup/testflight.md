# Building Dream for TestFlight

**Why:** this puts the real app on your phone, and on your friends' phones.

**Needs:** a Mac with **Xcode 26.4 or newer**. Expo SDK 58 doesn't compile on 26.3 or older. Your own Mac works, and
so does a Namespace Mac created with the selector `macos.version=27.x` (macOS 27.2 with Xcode 26.6, 27.0, 27.1 and
27.2; `build-ios.sh` picks 26.6). The `26.x` image stops at Xcode 26.3. Do [apple-developer.md](apple-developer.md) first, and
ideally [apns.md](apns.md) and [google-oauth.md](google-oauth.md) too: their values are baked into the build.

**No Mac of your own?** Tell me and I'll run steps 1 and 3 on a Namespace Mac. The App Store Connect key from step 2
then has to reach that Mac without passing through Chat or my logs, so we'd set that up together first.

**1. One-time Mac setup**

```sh
xcode-select -p                      # should point at Xcode 26.4+; if not: sudo xcode-select -s /Applications/Xcode.app
brew install node@24 cocoapods
curl -fsSL https://bun.sh/install | bash
git clone <the Dream repo's code.storage URL> dream && cd dream
bun install
```

**2. An App Store Connect API key (for signing and upload)**

1. appstoreconnect.apple.com → **Users and Access** → **Integrations** → **App Store Connect API** → **Team Keys** →
   **+**.
2. Name "Dream builds", access **App Manager** → **Generate**.
3. **Download** `AuthKey_<KEYID>.p8` (once only). Note the **Key ID** and the **Issuer ID** shown above the table.

This is the same kind of key an agent asks for with `dream access apple` when it ships one of *your* apps. Making a
separate key for each is fine, and lets you revoke one without the other.

**3. Build and upload**

From the repo root, on an up-to-date `main`:

```sh
DREAM_APPLE_TEAM_ID=AB12CD34EF \
DREAM_BUNDLE_ID=build.omer.dream \
DREAM_GOOGLE_IOS_CLIENT_ID=1234-abc.apps.googleusercontent.com \
apps/mobile/scripts/build-ios.sh testflight \
  --asc-key-path ~/Downloads/AuthKey_XXXXXXXXXX.p8 --asc-key-id XXXXXXXXXX --asc-issuer-id <issuer uuid>
```

- Leave out `DREAM_GOOGLE_IOS_CLIENT_ID` if Google isn't set up yet. You can still sign in with the dev secret
  (below).
- The script picks the live backend (`https://dream.omer.build`) and production push on its own.
- It takes 10–20 minutes, and ends after the upload.

**4. TestFlight**

1. App Store Connect → your app → **TestFlight**. The build shows up after Apple's processing (5–30 minutes).
2. Answer the export-compliance question: it uses only standard HTTPS encryption, so the answer is "None of the
   algorithms mentioned above".
3. Add testers:
   - **Internal Testing**: add yourself as a tester. Builds are available right away.
   - **External Testing**: create a group and add friends' emails. The first build goes through a short beta
     review (about a day).
4. Install **TestFlight** from the App Store on your phone, accept the invite, and install Dream.

**Signing in before Google is set up:** on the sign-in screen tap **Use a dev secret instead** and enter your email
and the dev secret. To read the secret: Cloudflare dashboard → **Storage & Databases** → **D1** → **dream-ops** →
**Console**, then run

```sql
SELECT value FROM settings WHERE name = 'DEV_LOGIN_SECRET';
```

Friends also need an invite first: see [invite-friends.md](invite-friends.md).

**Tell me:** when a build is on your phone, so I can check push and Live Activities against it. Also tell me if the
script fails, and send its last 30 lines.
