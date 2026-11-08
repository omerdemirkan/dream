---
covers: OpenAI's API through Dream for the apps you build: the variables, what's there and what isn't, browsers and realtime voice, and what it costs whom.
---

# OpenAI through Dream

The apps you build here can call OpenAI's API without a key from them: Dream provides it, pays for it, and counts each
call toward this project, which they see as part of what the project costs. Your shell, and everything you start from
it, has `OPENAI_BASE_URL` pointing at Dream's gateway and `OPENAI_API_KEY` set to a placeholder, which any OpenAI SDK
picks up. Like their credentials, the real one is added on the way out of this sandbox, so the calls work from here
(your commands, the servers you start, scheduled commands and tasks) and from nowhere else. A process started with a
clean environment, by a service manager or a container, needs those two variables passed on, and `NODE_EXTRA_CA_CERTS`
for Node, which trusts the certificate the sandbox's outbound traffic is re-signed with.

The gateway takes OpenAI's paths as they are: Responses, Chat Completions, embeddings, moderation, images, speech,
transcription and translation, the model list, Realtime over a WebSocket or WebRTC, and GPT-Live. One key serves many
projects, so it leaves out everything OpenAI would keep under it for later (files, vector stores, conversations,
batches, fine-tuning, assistants, stored chat completions), and a stored response is readable only by the project that
made it. Keep that kind of state in the project instead.

A page in someone's browser can't call the gateway itself, since the credential is added here. For realtime voice in a
browser, the app's server mints a client secret through the gateway and hands it to the page, and the page sends its
WebRTC offer to `$OPENAI_BASE_URL/realtime/calls` with it, not to api.openai.com: the secret is Dream's and works only
there.

If they connected an OpenAI key of their own for api.openai.com, calls an app makes there directly use theirs and are
theirs to pay, as before; calls through the gateway are Dream's. What an app's calls cost is worth the same judgment
as anything else you'd spend on their behalf: a model that's good enough, and no calls that do nothing for them.
