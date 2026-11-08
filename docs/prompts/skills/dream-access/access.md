---
covers: "`dream access`: how Dream keeps their credentials out of the sandbox, the access card and what makes it quick to fulfil, each kind (Google, OAuth providers, keys in a header, Apple, key files), and connections over time."
---

# Access to services

Real secrets stay out of this sandbox. Dream collects a credential from them once and keeps it in a vault, then adds
it to your outbound requests to that service, so your code only ever sends a placeholder. Anything they connect this
way is available to all of their projects. They trust Dream with their keys on that promise: a key pasted into Chat,
or written into a file here, can be read by any code that runs in this sandbox. That's why the one exception, a key
that can't travel in a request header, comes into this sandbox as a file only as a last resort, and only once
they've agreed to it.

Dream is something they fit in between other things, so a request they can fulfil in a minute gets fulfilled, and
one that sends them hunting waits. When the credential is a key they make themselves, that minute depends on your
card: a link to the exact page where it's made, what to tap there, and a sentence on why you need it.

`dream access …` asks for access to a service. It shows up like a question, with a way to connect. `--why` is its
heading, which they read first and often alone, on the lock screen, so it says what they're connecting and what for,
as in "Connect Gmail so I can read your newsletters". `--context` adds markdown on the card and just above where they
paste, which is where that link and what to tap belong. Links open in Safari, and they come back to paste. Every card
can also be emailed to them, when they ask, to finish in a browser on a computer, which is easier for a long key or a
developer console; `--context` shows there too, so its links work on either.

When they connect, you get an event naming the placeholder to use. Dream adds the real value to your HTTPS requests
to that host, so this works for anything that authenticates with a header.

- `google --scopes …` lets them sign in with Google and grant the scopes you name. Like `oauth` below, it works only
  once whoever runs Dream has registered Dream's Google app, and when they haven't, `dream access google` says so
  before any card reaches them.
- `oauth <provider> --scopes …` lets them sign in to a service that uses OAuth and grant the scopes you name, in that
  provider's own names. Dream knows `spotify`, `github`, `strava`, `dropbox`, `slack`, `notion`, `microsoft`
  (Outlook, OneDrive and the rest of Microsoft Graph) and `oura`. Each one works only once whoever runs Dream has
  registered it, and when one isn't, `dream access oauth` says so before any card reaches them.
  - The sign-in happens on their phone, on the provider's own page, so nothing about it needs a redirect URL, a
    client id or a client secret from you or from them.
  - Dream holds the refresh token and keeps the access token current on that provider's API hosts. The event names
    those hosts, the placeholder, and anything else the API needs, such as a version header. A GitHub connection
    also covers git over HTTPS to github.com.
  - Connecting a provider again replaces the earlier connection and keeps the scopes it had.
- `key --service … --host … --header … --format "Bearer {key}"` lets them paste a key, and tells Dream where the key
  belongs. `--host` is the real host your requests go to, like `api.stripe.com`. A key card isn't a place to keep
  values you'd send some other way.
  - Only a key sent in a header can be swapped in. A key sent in a URL or a request body can't, for example in
    Telegram's bot URLs (`api.telegram.org/bot<token>/…`). Discord's REST API takes `Authorization: Bot …`
    (`--host discord.com --header Authorization --format "Bot {key}"`), and a relay logs in to Discord's Gateway with
    that same key, so a Discord bot needs no more than `key`.
  - A key also has to last. A pasted OAuth token stops working within hours, which is why services that hand out
    short-lived tokens, such as Spotify, Strava or Dropbox, connect with `dream access oauth` instead. An OAuth
    service Dream doesn't know can't be connected yet.
- `apple` asks for their App Store Connect API key, which TestFlight needs. Its card already links Apple's guide to
  making one.
- `file --service … --name …` is the last resort, for a key that can't go in a header: Telegram's bot token, an SMTP
  password, a secret an API wants in the request body. They type it into a secure field, and Dream writes it to
  `~/.dream/keys/<name>` in this sandbox, outside your project.
  - Their card warns them that the key will live in this sandbox, where any code that runs here can read it, so it's
    worth asking only when no header can carry it.
  - It belongs to this project alone. Their other projects don't get it, and a new sandbox for this project gets it
    again. Entering it again replaces the file, from your card or from their Settings; after a change in Settings you
    get an event, and anything that read the old key needs a restart. If they remove it, Dream deletes the file and
    you get an event.
  - Have your code read the file each time it starts. Don't print it or put it in a command, a log, the project's
    files, its git history, or anything you send: what you see here goes to the model provider. `dream` refuses to
    send text that contains it. Under Claude Code, reading the folder or naming it in a command is refused, so put
    the path in your code or its config.
- `--when "around Thursday"` marks a need for later. It shows as upcoming, so they can connect it early or wait until
  you ask again.
- They can decline a request instead, and may say why ("Use a free option instead"); the event carries their reason.
  They can still connect it later from the card.
- `dream access list` shows what they've already connected. All of it already works here. A sign-in the provider
  stops accepting (they revoked it, or it lapsed) drops out of the list, and requests that relied on it are refused
  until they connect it again.
- When something this project asked for goes away, because they removed it in Settings or its provider stopped
  accepting it, you get an event, and your card for it says so; they can connect it again from that card. If it
  stopped working and they connect it again from another project, you get an event saying it's back.
