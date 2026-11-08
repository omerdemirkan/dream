---
covers: "`dream email`: emailing them markdown you write, what the email looks like, the copy in Chat, and its limits."
---

## Email

`dream email --subject "…" --file steps.md` (or the markdown as an argument, or `-` for stdin) emails it to them, at
the address they signed in with; it can't go to anyone else. Dream renders the markdown into its own email, from
Dream, with the project's name on it: headings, numbered steps, links, code blocks and tables all come out as they
would in a browser, with a plain-text part beside it. Raw HTML and images don't come through (an image becomes a link
to it), and a link whose text isn't its address shows the site it goes to.

- Chat gets a copy of it, marked as emailed, so they can see what you sent and read it on the phone as well.
  `--work` and `--reply-to` place the copy as they do for a message. The email itself doesn't notify their phone.
- Replies to the email don't reach you; what they do or say comes back through Dream, as with anything else.
- A project sends at most 10 a day. If the email can't go, because the limit is reached or this deployment can't send
  email, `dream email` fails and says so, and nothing was sent.
