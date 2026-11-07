---
covers: "`dream relay`: Discord's Gateway and WebSocket feeds held open by Dream, how events reach your app, signatures, state, and limits."
---

## Relays

Some services only tell you what happened down a connection you keep open: Discord's Gateway (ordinary messages in a
server; Discord sends no webhooks for those), exchange and market feeds, other WebSocket streams. A sleeping sandbox
can't keep one open, so Dream holds it for you, outside the sandbox, and POSTs each event to your app, which wakes the
sandbox like any request.

- `dream relay discord --to /hooks/discord [--port 3000]` holds the bot's Gateway session, logging in with their
  Discord key (the `key` for discord.com that the bot's REST calls use). It forwards `MESSAGE_CREATE` unless you name
  others with `--events`. `--mentions` forwards only messages that mention the bot, reply to it, or are sent to it
  directly, and `--channel <id>` only those in a channel. The bot's own messages never come back.
  - Reading what people write needs Message Content Intent switched on for the bot, in the Developer Portal under
    Bot. Without it the relay fails and says so.
  - Slash commands and buttons can come over a relay too (`INTERACTION_CREATE`), but Discord wants an answer within
    three seconds, so its interactions endpoint, a webhook to your published URL, is the surer way for those.
- `dream relay websocket wss://… --to /hooks/feed` holds any WebSocket feed. `--send` subscribes after every connect.
  `--key <id>` puts one of their keys' header on the connection, and only to that key's own host. `--ping` and
  `--ping-every` keep a feed that drops quiet clients, `--silence <seconds>` reconnects one that goes quiet, and
  `--match` forwards only messages containing that text.
- Each event arrives as a POST to `http://localhost:<port><path>`: the published port, or the one you give with
  `--port`, which needn't be published. The JSON body has `id`, `relay`, `source`, `type` (Discord's event name),
  `at` and `data`, which is Discord's event as it sent it, or the feed's message, parsed if it's JSON. Answer 2xx once
  you've handled it; the sandbox stays awake while you do, and goes back to sleep soon after. Anything else, or no
  answer within two minutes, and it's tried again later, so a broken route holds back the events behind it. Events
  wait up to a day.
  - Delivery is at least once, so drop an `id` you've already handled.
  - The route may also be reachable on your public URL, so check that a request came from Dream.
    `Dream-Signature` is `v1=` and the hex HMAC-SHA256, keyed with the contents of `~/.dream/relay.key`, of
    `Dream-Timestamp`, a dot, and the raw body:
    ```js
    const key = readFileSync(join(homedir(), ".dream/relay.key"), "utf8").trim()
    const signed = `${req.headers["dream-timestamp"]}.${rawBody}`
    const expected = `v1=${createHmac("sha256", key).update(signed).digest("hex")}`
    // Compare with timingSafeEqual, and refuse a timestamp more than five minutes old.
    ```
- `dream relay list` shows each relay's state (connecting, connected, retrying or failed), what it has delivered,
  what's waiting, and recent problems. One that fails for a reason retrying can't fix, such as a revoked token or an
  intent that isn't switched on, wakes you once with why. `dream relay restart <id>` tries again once it's fixed, and
  it restarts by itself when they connect a new key. You also hear when your app hasn't taken its events for an hour.
  `dream relay remove <id>` closes it.
- A project can have three. Each holds a connection open around the clock, so use one when no webhook or schedule
  would do. A feed has no memory: what it sends during a reconnect (seconds) is missed, so a relay suits live updates
  more than a record you can't lose. Discord's Gateway does replay what was missed, for a few minutes.
- Relays stop while the project is archived and start again when it's restored.
