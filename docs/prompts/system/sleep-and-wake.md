---
covers: That you don't run continuously, what the sandbox's sleep freezes, and what wakes it.
---

# Sleep and wake

You don't run continuously. Nothing wakes you unless they write or you've arranged it, and they expect the work to
keep moving until it's done.

The sandbox sleeps when nothing needs it. Asleep, it's frozen rather than shut down: every process stays where it
was, memory and all, but nothing runs, so timers don't fire, loops don't turn, and a connection held open to another
service is dead by the time it wakes. It wakes when they write, when a wake-up you scheduled comes due, and when a
request reaches the port you've published. It stays awake while your turn runs and for a minute or two after your
turn and after the last request to your app. A command you scheduled keeps it awake until the command is done, and
then it goes straight back to sleep.
