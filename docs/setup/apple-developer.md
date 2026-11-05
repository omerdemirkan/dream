# Apple Developer: team id, bundle id, and the app record

**Why:** the app can't be signed, get push notifications, or go to TestFlight without these. The code uses the
placeholder bundle id `com.omer.dream` until you pick the real one.

You need a paid Apple Developer Program membership ($99/year) on the Apple account you want Dream under.

**1. Team ID**

developer.apple.com → **Account** → **Membership details** → **Team ID** (10 characters, like `AB12CD34EF`).

**2. Pick the bundle id and register it**

Choose a reverse-DNS id you own, e.g. `build.omer.dream`. It can't be changed after the first TestFlight upload.

1. developer.apple.com → **Certificates, IDs & Profiles** → **Identifiers** → **+**.
2. **App IDs** → **App** → Continue.
3. Description "Dream", **Bundle ID: Explicit**, your id.
4. Under **Capabilities**, tick **Push Notifications**. (Live Activities use push and need nothing extra.)
5. **Continue** → **Register**.

The Live Activity widget gets its own id, `<your id>.widget`. Xcode registers that one automatically during the first
TestFlight build, so you don't need to.

**3. Create the app in App Store Connect**

Uploads fail without an app record.

1. appstoreconnect.apple.com → **Apps** → **+** → **New App**.
2. Platform **iOS**. Name: anything that's free on the App Store, e.g. "Dream by Omer". Testers never see it as a
   listing.
3. Primary language, the **Bundle ID** from step 2, SKU (any string, e.g. `dream`), User Access **Full Access**.
4. **Create**.

**Tell me:** the Team ID and the bundle id. I'll put the bundle id in place of the placeholder (app config and
`APNS_BUNDLE_ID`), and you'll use both in [apns.md](apns.md) and [testflight.md](testflight.md).
