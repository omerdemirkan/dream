# QA log

Newest at the bottom. Each entry: archetype, what was done, result, issues (platform vs agent behaviour), fix.

## 0. First end-to-end run — to-do web app (2026-11-05 03:17 UTC)
- Project `prj_yPdr2HMIiO6tmBkrCYUppX`, Claude Code default model (before the Haiku setting).
- Pass: sandbox create, dreamd start, real Claude token via E2B egress, `dream publish`, `dream status`, `dream message`.
- Agent behaviour: built in ~45 s without asking anything (the idea said "keep it small; quick test"); tested only via
  API; the page served a JSON-serialized Buffer instead of HTML. It said it hadn't opened it on a phone.

## 1. Fix loop on the to-do app — message → wake → fix (03:28 UTC)
- Sent "the page shows {"type":"Buffer"...}". Gateway auto-resumed the paused sandbox (1.4 s on a later GET).
- PLATFORM BUG: the env rewrite (adding DREAM_MODEL for Haiku) raced the delivery. The old dreamd started the turn,
  then saw the env change and hung forever in shutdown (bridge child alive), so the supervisor never restarted it and
  the project was stuck. Unblocked by killing dreamd; the supervisor restarted it, and the on-disk inbox requeued the
  event (durability OK). Fix dispatched: `fix/dreamd-restart` (bounded shutdown + DO waits for the new dreamd).
