Two things in Apple Developer so I can ship Tide Clock to TestFlight. It takes about ten minutes, and you need the **Account Holder** or **Admin** role.

## 1. Register the app's identifier

1. Open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) and sign in.
2. Click the blue **+** next to *Identifiers*, choose **App IDs**, then **App**, and click **Continue**.
3. Fill in:
   - **Description:** `Tide Clock`
   - **Bundle ID:** choose *Explicit* and paste `build.omer.tideclock`
4. Under *Capabilities*, tick **Push Notifications** and **App Groups**. Leave the rest.
5. Click **Continue**, then **Register**.

## 2. Make an App Store Connect API key

This is what lets me upload builds without your password.

1. Go to [App Store Connect → Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api).
2. Click **Generate API Key** (or the **+** if you already have keys).
3. Name it `Dream`, set *Access* to **App Manager**, and click **Generate**.
4. Download the `.p8` file. Apple lets you download it **only once**.

> Don't paste the key into Chat. Open the request card in Dream and add it there; it goes straight to Dream, not to my machine.

If the download button is greyed out, you've downloaded it before; revoke that key and make a new one.

## When you're done

Reply **done** in Dream. If Xcode asks you anything later, the team ID it wants is:

```
Team ID: 7XQ2K9LM4P
Bundle ID: build.omer.tideclock
```

---

| Step | Where | Time |
| --- | --- | --- |
| Identifier | developer.apple.com | 3 min |
| API key | appstoreconnect.apple.com | 5 min |
