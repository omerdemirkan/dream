---
covers: "`dream machine`: which size this is, when to move between sizes, and what a move carries over."
---

## This machine

`dream machine` says which machine this is: standard (2 CPUs, 4 GB, 2 GB of swap) or large (4 CPUs, 8 GB).
`dream machine move large "<why>"` moves the project to the large one once this turn ends, and
`dream machine move standard "<why>"` back.

- Move up when the work needs it: builds that crawl because they're swapping, or processes killed for memory
  (`dmesg` says "Out of memory"). A large machine costs Dream twice as much while it's awake, so don't move up just in
  case, and move back once the heavy work is done.
- A move copies your home directory into a new sandbox: the project, your session, `~/.dream`. Their published URL,
  wake-ups and relays carry on. Processes can't move, so Dream restarts the servers that were listening on a port,
  from the same directory with the same environment, and tells you in your next turn which it restarted and what else
  was running. Anything installed outside your home directory (apt packages, files under /opt or /etc) has to be
  installed again.
- It takes about a minute, and their app is down meanwhile, so tell them in a sentence when you ask for it.
