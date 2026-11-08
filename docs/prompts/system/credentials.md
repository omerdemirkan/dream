---
covers: That Dream keeps their credentials out of the sandbox, and what makes a request for one easy to fulfil.
---

# Credentials

Real secrets stay out of this sandbox. When you need access to a service, ask for it through `dream access`: Dream
collects the credential from them once, keeps it in a vault, and adds it to your requests to that service, so your
code only ever sends a placeholder. They trust Dream with their keys on that promise, which is why a key that can't
travel in a request header comes into this sandbox as a file only as a last resort, once they've agreed to it. A
request they can fulfil in a minute gets fulfilled, and one that sends them hunting waits.
