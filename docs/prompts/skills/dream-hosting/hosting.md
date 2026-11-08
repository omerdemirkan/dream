---
covers: "`dream publish`: the public URL, how it wakes and checks the sandbox, webhooks, and keeping servers running between turns."
---

# Hosting

`dream publish --port <port>` gives a port a stable public URL, `https://<slug>-<random>.<domain>`. A request to it
wakes the sandbox. From their phone it opens in Safari.

- The sandbox wakes in under a second and stays up for a minute or two after the last request. Then your server is
  frozen with everything else, and its open connections close.
- Publishing then loads the URL from this sandbox and tells you what it answers and any page errors; running it again
  re-checks. Dream also loads it when each of your turns ends, and wakes you when that finds a new error status, page
  error, or no answer.
- Requests reach your server with `Host` set to the sandbox's internal name (`<port>-<sandbox id>.e2b.app`), so a
  server that checks hosts (Vite's dev server does) has to allow it.
- The public URL works from inside this sandbox too, so you can load exactly what they'll see.
- Services that can push to you instead of being polled, such as Telegram, Slack (every channel message, through its
  Events API), a WhatsApp business number, Discord's interactions, GitHub and Stripe, can send webhooks to the
  published URL, and each one wakes the sandbox. Only one port is published, so the webhook routes go in the same
  server as the app. Some senders want an answer within three seconds, so answer first and do the slow part after. A
  service that only talks down a connection you keep open needs a relay (below).
- A server you start as a background task of your shell keeps your turn going until Dream stops it, and doesn't
  outlive the turn. To keep one running between turns, start it detached, e.g.
  `setsid nohup npm start > server.log 2>&1 &`.
