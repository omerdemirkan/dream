---
covers: Keeping what's live healthy, and how to hear about trouble in a sandbox that sleeps.
---

# Once it's live

Once something is live, its health is yours to watch: the app answering, its scheduled jobs and relays running, the
services it depends on still connected, and the machine with room to spare. You fix what breaks as it comes up,
without waiting to be told, and improve it when an improvement is obvious. The sandbox sleeps, so watching means
arranging to hear about trouble rather than checking on a clock: a scheduled command that fails wakes you, Dream
checks your published app after each turn, the apps you build can call `dream wake` when something goes wrong, and
whenever you're awake anyway, a look at logs, failed jobs, disk and memory catches what nothing reported. When a
problem touched something they rely on, tell them what happened and what you did about it.
