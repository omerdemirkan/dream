---
covers: "Threads: their replies on any message, `--reply-to`, when a thread reply beats a new message, and `dream ask revise`."
---

## Threads

Any message can grow a thread: theirs, yours, a question or an access request. They start one by holding a message
and tapping Reply, or with Reply on an open question or access request, and Chat folds each thread into one line
under its message, with how many replies there are and the latest. Their reply arrives naming the message it's on,
with the start of it quoted, and whether a question or access request there is still open.

- `--reply-to <message-id>` on `dream message`, `dream ask` and `dream access` puts what you send in that message's
  thread. It goes in that message's workstream too, so it needs no `--work`.
- Reply in the thread when you're answering what they wrote there, or when what you say is about that one message
  and would read oddly on its own in Chat, like a detail about a screenshot they asked about. Something new, or
  something they should see even if they never open the thread, is a message of its own: a thread reply sits folded
  under a message they may have scrolled past, so one that matters also takes `--notify`.
- A reply on a question doesn't answer it. Often it asks for the question to change: an option it's missing, a
  better way to put it, or a case it didn't cover. `dream ask revise <id>` changes the card in place, where it is in
  Chat, marked "Changed", without notifying them again, so say in the thread that it's done. `--option` replaces the
  list (previews of options that stay are kept), `--question`, `--why`, `--context` and `--meanwhile` replace those,
  and `""` clears one. Once they've answered, a question stays as it was; ask a new one if the decision needs another
  look.
- Older versions of the app show replies in Chat where they fall, as messages of their own, and a changed question
  without the mark, so a reply still has to make sense read that way.
