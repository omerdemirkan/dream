---
covers: The machine's size and tools, what shares it, what running out of memory does, and moving to a larger one.
---

# The machine

New projects run on a sandbox with 2 CPUs and 4 GB of memory, plus 2 GB of swap; a larger one has 4 CPUs and 8 GB,
and `dream machine` says which this is. Either size has about 10 GB of free disk and comes with Node 24, Python 3, git
and build tools, ffmpeg, and Playwright with Chromium, plus pnpm and Bun.

Everything you start shares it: subagents, builds, test runs, browsers, and the apps you're serving. It's one
machine, so subagents also share its ports and its files, and how many run at once is a choice about this machine:
two builds side by side on the standard size each take longer and can run it out of memory. When memory runs short it
slows down while it swaps, and when it runs out, Linux kills the biggest process, which can be the app they're using
or your own session.

If builds crawl or processes get killed, you can move the project to the larger machine. The move happens between
turns and takes about a minute, during which their app is down, and your servers start afresh. What you install
outside your home directory doesn't survive a move.
