# Building Dream for TestFlight

**Why:** this puts the real app on your phone, and on your friends' phones.

**Needs:** a Mac with **Xcode 26.4 or newer**. Expo SDK 58 doesn't compile on 26.3 or older. Your own Mac works, and
so does a Namespace Mac created with the selector `macos.version=27.x` (macOS 27.2 with Xcode 26.6, 27.0, 27.1 and
27.2; `build-ios.sh` picks 26.6). The `26.x` image stops at Xcode 26.3. Do [apple-developer.md](apple-developer.md) first, and
ideally [apns.md](apns.md) and [google-oauth.md](google-oauth.md) too: their values are baked into the build.

**No Mac of your own?** Do step 2, then follow **On a Namespace Mac**

You store the key once, as a secret on Dream's Worker. Each build starts a fresh Mac. The Worker hands the key
to that one Mac, encrypted so only that Mac can read it, after checking with Namespace that the request really
comes from it. The Mac builds and uploads, then the key is deleted and the Mac destroyed. The key never passes
through Chat, my logs, an env var, or a Dream project.

1. Open the `.p8` from step 2 (Dream's is `AuthKey_5G566N355S.p8`) in your password manager or a text editor,
   and copy **all** of it, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.
2. dash.cloudflare.com → **Workers & Pages** → **dream-api** → **Settings** → **Variables and Secrets** →
   **+ Add**.
   - **Type:** Secret
   - **Variable name:** `ASC_TESTFLIGHT_KEY_P8` (exactly this)
   - **Value:** paste the key. If the line breaks turn into spaces, that's fine.
   - **Deploy**.
3. If you made the `dream-vault-dummy` secret in Namespace's vault for the earlier test, delete it there
   (cloud.namespace.so → Vault → the secret → Delete). Don't put the real key in Namespace's vault: Namespace
   writes vault values in clear into the build Mac's logs.
4. Tell me it's in. You don't need to send anything else.

Then I run, from the repo on an up-to-date `main`:

```sh
node apps/mobile/scripts/testflight-namespace.ts check       # ~1 min, builds nothing
node apps/mobile/scripts/testflight-namespace.ts testflight  # 15–25 min, uploads
```

`check` makes sure the key arrives intact, then signs one read-only App Store Connect request with it (it looks
up the "Dream by Omer" record). It prints only the key's size, file mode and a short hash, never the key.
`testflight` then builds and uploads, as step 3 would on your Mac.

- **New key:** set `ASC_TESTFLIGHT_KEY_P8` again in the same place.
- **Stop it:** delete `ASC_TESTFLIGHT_KEY_P8`, or revoke the key in App Store Connect (Users and Access →
  Integrations → the key → Revoke). Either takes effect at once.
- **Who can get it:** only a Namespace Mac in Dream's workspace that I started for a build, within 15 minutes
  of starting it, once, and only while it's the workspace's only Mac. Unlocking each build takes Dream's
  operator secret, which project agents don't have.

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
