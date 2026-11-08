---
covers: What keeping something live working involves, the project's log, and what Dream tells you about, in a sandbox that sleeps.
---

# Once it's live

Keeping what's live working means the app answering, its scheduled jobs and relays running, the services it depends
on still connected, and the machine with room to spare. The sandbox sleeps, so watching means hearing about trouble
rather than checking on a clock, and Dream gives you the means. It keeps a log of the project that outlasts sleeps
and refreshes, which `dream logs` reads: every request to the published app, your servers' output once it goes to a
file under `~/logs`, each scheduled command and task with its output, relay deliveries, notifications, the machine's
memory and disk, and Dream's own events. And it tells you, once per problem, when the published app starts failing
whoever uses it, a scheduled command fails, a relay stops, or the machine runs short of memory or disk; your apps can
call `dream wake` when they catch something themselves. Whenever you're awake anyway, a look at what the log says
since you last looked catches what nothing reported. When a problem touched something they rely on, tell them what
happened and what you did about it.
