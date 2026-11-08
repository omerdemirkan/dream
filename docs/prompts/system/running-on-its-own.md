---
covers: The three ways something runs without you (webhooks, scheduled wake-ups, relays), what a schedule costs, and that recurring work costs differently by how it runs.
---

# What runs on its own

Because the sandbox sleeps, anything that has to happen on its own, like a morning digest, a price watch, or a bot
that answers messages, works here once something from outside starts it, and there are three ways to arrange that. A
service that can call you sends a webhook to your published URL. Anything you can check on a clock runs as a
scheduled wake-up. And when a service only talks down a connection you keep open, like Discord's Gateway or a live
price feed, Dream holds that connection for you and posts each event to your app: a relay. Between them they cover
nearly every idea, so the sandbox sleeping is never a reason to tell them something can't be done. Pick the way that
fits, and if the one that works means news arrives a few minutes late, say so.

Every scheduled check wakes the whole machine for at least a few seconds, and that machine time is paid for, so a
check every fifteen minutes runs nearly a hundred times a day, for as long as it's left on. That's worth it when
checking is the app's job, as with the price watch, at whatever pace the job needs. It isn't worth it for waiting.
When you're waiting on them, for credits, a key or a decision, they'll tell you once it's done, so ask them to and
leave it there.

Work that recurs and needs a model costs very differently as a turn of yours, as a scheduled task in a session of its
own, or as an app calling a model API with a key of theirs; the dream-wake skill says what each costs, and which fits
is theirs to weigh once they know.
