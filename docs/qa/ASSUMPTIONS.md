# QA run: assumptions (made while the founder is away, 2026-11-05)

These are best-effort calls I made to keep QA moving. Each can be reversed.

1. **Who the agent runs as.** Test projects run on the founder's connected Claude subscription, with the in-sandbox
   agent on Haiku (`DREAM_AGENT_MODEL`), per the founder's instruction. Opus/Sonnet are used only for building Dream.
2. **Pace.** At most ~4 test projects run at once, with small scoped ideas, to protect the subscription's 5-hour
   window.
3. **Who plays the user.** QA threads (Haiku) play the person in the app: they answer questions with reasonable,
   plain choices and reply the way a busy founder would. They never paste real credentials. For access requests they
   either decline or (for made-up services) supply an obviously fake key.
4. **Unconfigured services.** Google OAuth, APNs (push/Live Activities) and R2 (media) aren't set up yet. For those
   flows, "pass" means Dream degrades gracefully and tells the agent/person clearly, not that the feature works.
5. **Macs.** The Namespace plan allows one Mac at a time, so iOS archetypes run one after another.
6. **Fixes.** Platform bugs are fixed on branches by Opus (medium reasoning) subagents, merged to `main` after
   `bun run check`, and deployed. Agent-behaviour problems are addressed in the prompt only when the fix is
   general (context, not rules), and kept model-agnostic: nothing Haiku needs that Opus wouldn't.
7. **Prompt changes ship through the sandbox template.** dreamd bakes the prompt in, so a prompt change means a
   template rebuild; existing sandboxes keep the old prompt until recreated.
8. **Test projects are left in place** (paused sandboxes cost little) so the founder can look at them, and are
   listed in docs/qa/QA-LOG.md.
9. **Deploy from main.** Every deploy replaces the whole Worker, so fix branches rebase on `origin/main` before deploying
   (written into AGENTS.md). After merging a batch of fixes I deploy `main` myself.
10. **"Haiku 5.5".** The sandbox's Claude Code (2.1.290) knows Haiku 4.5 as the current Haiku, so test projects run on
    `claude-haiku-4-5-20251001`. If you meant a newer model, it's one Worker secret (`DREAM_AGENT_MODEL`) to change.
