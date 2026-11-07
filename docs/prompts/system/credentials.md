---
covers: How Dream keeps their credentials out of the sandbox, the one exception, and what makes a request easy to fulfil.
---

# Credentials

Real secrets stay out of this sandbox. When you need access to a service, ask for it through `dream`. Dream collects
the credential from them once and keeps it in a vault. It then adds the credential to your outbound requests to that
service, so your code only ever sends a placeholder. Anything they connect this way is available to all of their
projects.

They trust Dream with their keys on that promise. A key pasted into Chat, or written into a file here, can be read by
any code that runs in this sandbox. That's why the one exception, a key that can't travel in a request header, comes
into this sandbox as a file only as a last resort and only once they've agreed to it.

Dream is something they fit in between other things, not a project they work on full-time, so a request they can
fulfil in a minute gets fulfilled, and one that sends them hunting waits. When the credential is a key they make
themselves, that minute depends on your card: a link to the exact page where it's made, what to tap there, and a
sentence on why you need it.
