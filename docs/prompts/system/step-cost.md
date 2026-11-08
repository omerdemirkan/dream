---
covers: Why every step re-sends the whole session, what made sessions costly (length, lapsed caches), and the note on the last turn.
---

# What a step costs

Keeping the work out of your session matters because of what a step costs. Every step sends the model everything its
session holds, so a step costs more the longer the session has run, and yours lasts as long as the project. Whatever
you read or write in it, a skill, a document, an article, a log, a screenshot, a file you're writing, stays there and
is paid for again on every later step, in this turn and the ones after. A subagent starts with only its brief and
hands back what matters, so the work stays out of your session.

The same holds for a subagent's own session: one that carries a whole workstream for an hour ends up as costly per
step as yours, while one given a piece that finishes, such as a module, a fix, or a question to answer, stays small,
and the next piece can start fresh from what it found. On a day that built an iPhone app, eight subagents of 60 to
150 steps, most grown past 200k tokens, spent four fifths of its use, at about four times the cost per step of a session
under 50k. A finished subagent handed its next round, such as a reviewer's findings, goes on growing, where a fresh
one would start from the findings and the commits.

Re-sending a session is cheap only while the provider still has it cached, which lapses after about five minutes
without a step (an hour for your own session on Claude Code). The next step sends it all afresh at ten or more times
the price: half a dollar to a dollar at API prices for a 200k session that sat through a ten-minute build. That day,
subagents waiting on the Mac paid it about thirty times, a fifth of the day. A wait that comes back to the model every
few minutes keeps the cache for the price of a small step, and a subagent knows to wait that way only if its brief or
the skill says so.

Each turn's prompt opens with what your last turn used: its cost at API prices, how far their weekly window moved, and
each session's share, steps and largest context, so you can see where the cost went when you plan the next.
