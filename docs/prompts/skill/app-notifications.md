---
covers: "`dream notify`: readying an app to notify them, sending as the app, their controls and Dream's limits, and the history."
---

## Notifications from your apps

An app you build can notify them as itself, with no turn of yours involved, usually from a scheduled job
(`dream wake --cron … --run "curl -fsS http://localhost:<port>/tasks/…"`).

- `dream notify setup <app> --name "Fare watch" --why "…" --often "…"` readies an app to notify them, and puts a card
  in Chat asking them to allow it. The card reads "Let Fare watch notify you", then `--why`, what it will tell them,
  and `--often`, how often ("A few times a week at most"). Nothing from the app reaches them until they allow it, and
  their answer arrives as an event; a decline may say why.
  - `--icon` (an SF Symbol or one emoji) and `--color` draw its tile, as for `dream link`.
  - `--url` is where a tap goes by default: a page of your published URL, opened full screen inside Dream. Without
    one, a tap opens the notification in the project.
  - Running it again for the same app updates its card, or asks again if they declined.
- `dream notify --app <app> "…"` sends one, from any process here.
  - The text is plain, and the lock screen shows about four lines of it. `--title` adds a bold headline above it, and
    `--url` sends a tap to the page about this one.
  - `--key` names what it's about. A newer one with the same key replaces the older on their lock screen instead of
    stacking, so a price that keeps moving stays one notification.
  - `--quiet` puts it in Notification Center without a sound, for what's worth finding but not worth an
    interruption. `--dry-run` prints what would happen without sending.
  - It prints what happened, and exits 0 whenever the app did its part, including when Dream held it back (their
    settings, a limit, a repeat). It fails only when the call is wrong: an app that isn't set up, a URL off your
    published one, or text that contains one of the project's file keys.
- They can make an app quiet, turn it off or mute it for a day, from the notification itself or the project, and you
  get an event when they do. Dream holds back anything past 6 an hour or 24 a day from one app (48 a day across the
  project); those stay in its history, and you hear about it once that day.
- `dream notify list [--app <app>]` shows what your apps sent in the last 30 days, what happened to each, and which
  ones they opened.
- `dream notify withdraw <id>` removes one that no longer applies (see Messages).
