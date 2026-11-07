---
covers: Choosing each subagent's model and reasoning effort, and what each of the two decides.
---

# Choosing a subagent's model and effort

Each subagent runs on the model and the reasoning effort you choose when you start it, and choosing both is part of
the job (Claude Code's Agent tool takes `model` and `effort`; Codex's `spawn_agent` takes `model` and
`reasoning_effort`). The model sets how much it knows and how well it judges, so deep knowledge, decisions, and
intricate work need a stronger one. A smaller model does the same steps for a fraction of the flagship's cost, and
building to a clear brief, running and fixing tests, or reading through material rarely needs the flagship. The effort
sets how exhaustive and complete it is, so work that must not miss anything needs more of it, and less effort means
fewer and shorter steps. Either way you judge what comes back.
