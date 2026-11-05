# APNs key (push notifications and Live Activities)

**Why:** questions, access requests and `--notify` messages reach your lock screen through APNs, and so do Live
Activities. Without a key, nothing is pushed; the app only shows things when you open it.

Do [apple-developer.md](apple-developer.md) first (you need the Team ID and bundle id).

**1. Create the key**

1. developer.apple.com → **Certificates, IDs & Profiles** → **Keys** → **+**.
2. Name "Dream APNs", tick **Apple Push Notifications service (APNs)**. If it asks, choose environment **Sandbox &
   Production** and leave the key unrestricted to topics.
3. **Continue** → **Register** → **Download**. You get `AuthKey_<KEYID>.p8`. Apple lets you download it **once**, so
   keep it somewhere safe (a password manager).
4. Note the **Key ID** shown on the page (10 characters).

**2. Give it to the Worker**

Set these as Worker secrets (see "Setting a Worker secret" in [README.md](README.md)):

| Name | Value |
| --- | --- |
| `APNS_KEY_ID` | the Key ID |
| `APNS_TEAM_ID` | your Team ID |
| `APNS_BUNDLE_ID` | the app's bundle id (not the widget's) |
| `APNS_PRIVATE_KEY` | the whole contents of the .p8 file, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines |

`APNS_ENVIRONMENT` defaults to `production`, which is right for TestFlight builds. Set it to `development` only for
builds run straight from Xcode.

**Check:** after the TestFlight build is on your phone, allow notifications when it asks. Ask an agent something that
makes it ask you a question; the question should arrive on your lock screen.

**Tell me:** nothing, unless the test push doesn't arrive.
