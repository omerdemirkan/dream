# Prompting guidance behind Dream's prompts

What Anthropic and OpenAI publish about system prompts, skills and tool descriptions for agents, and what it means
for the prompts in `docs/prompts/`. Gathered 2026-11-08. Each quote below was checked against the page it cites.

## What the sources say

**Always-loaded context should be the smallest set that does the job.** Anthropic's
[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents):
"good context engineering means finding the smallest possible set of high-signal tokens that maximize the likelihood
of some desired outcome", with the caveat that "minimal does not necessarily mean short; you still need to give the
agent sufficient information up front". The same post names the two ways a system prompt goes wrong: "hardcoding
complex, brittle logic in their prompts to elicit exact agentic behavior" and "vague, high-level guidance that fails
to give the LLM concrete signals ... or falsely assumes shared context". It advises against "a laundry list of edge
cases ... to articulate every possible rule". Claude Code's
[best practices](https://code.claude.com/docs/en/best-practices) apply the same test to CLAUDE.md, which "loads into
every session, which means every line in it takes a little of Claude's attention on every task, whether it's relevant
or not", and keep it to what Claude "couldn't work out from the code itself". OpenAI's
[Codex best practices](https://learn.chatgpt.com/guides/best-practices): "A short, accurate `AGENTS.md` is more useful
than a long file full of vague rules."

**Situational detail belongs in skills, read when needed.** Anthropic's
[Agent Skills post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills):
"At startup, the agent pre-loads the name and description of every installed skill into its system prompt. This
metadata is the first level of progressive disclosure"; the body is read "if Claude thinks the skill is relevant to
the current task", and bundled files are "the third level (and beyond) of detail". Claude Code's best practices: "For
a skill Claude can start on its own, it sees the name and description in every session, but only reads the full file
when the task calls for it." Codex works the same way
([Build skills](https://developers.openai.com/codex/skills)): "ChatGPT and Codex start with each skill's name and
description, then load the full SKILL.md instructions when they decide to use that skill." OpenAI's best practices
add: "Keep each skill scoped to one job."

**A skill's description is what gets it read.** Anthropic's
[skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices):
the description "should include both what the Skill does and when to use it", written in the third person because it
"is injected into the system prompt". Claude Code truncates "the combined `description` and `when_to_use` text ... at
1,536 characters" and, when many skills overflow the listing's budget (1% of the context window), drops descriptions
of the least-used skills ([Skills](https://code.claude.com/docs/en/skills)). Codex caps the initial list at "2% of the
model's context window" and "shortens skill descriptions first", so it says to "Front-load the key use case and
trigger words".

**A skill should be short, and a long one loses its end.** The authoring guide: "Keep the `SKILL.md` body under 500
lines", "Only add context Claude doesn't already have", and "being concise in `SKILL.md` still matters: once Claude
loads it, every token competes with conversation history". Claude Code's skills docs: after compaction it "re-attaches
the most recent invocation of each skill after the summary, keeping the first 5,000 tokens of each", within 25,000
tokens for all of them. Dream's single `dream` skill was about 8,000 tokens, so a compacted Claude Code session kept it
only as far as about the middle of Waking, and lost hosting, relays, app links, browsers, the Mac, the machine and
usage.

**Tool help is prompt text too.** [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents):
"think of how you would describe your tool to a new hire on your team", namespacing "can help delineate boundaries
between lots of tools", and error responses should "clearly communicate specific and actionable improvements, rather
than opaque error codes". [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents):
"Tool definitions and specifications should be given just as much prompt engineering attention as your overall
prompts." Claude Code's best practices: "For a CLI it hasn't seen before, pointing it at `--help` is enough."

**Context and reasons over rules and emphasis.** Anthropic's
[prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices):
"Providing context or motivation behind your instructions ... can give Claude more information about your goals",
and since Opus 4.5 the models "are also more responsive to the system prompt than previous models"; "Where you might have said 'CRITICAL: You MUST use
this tool when...,' you can use more normal prompting". Claude Code's best practices: "piling on emphasis mostly makes
Claude over-apply the rule." OpenAI's [GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra)
(the Sol models Codex runs on are in it) warns that the model "can be more sensitive to instructions contained in
skills and other files" and that "unclear or conflicting guidance in a skill file may cause the model to pause and
block work early", which is a reason to say each thing once, in one place.

## What it means for Dream

- The system prompt keeps what every turn needs: who the agent is, the person and what they see, what good looks
  like, the sandbox and its sleep, orchestrating, cost, review and offering versions. What matters only in a situation
  (asking for a credential, designing an app's notifications, scheduling recurring work, outgrowing the sandbox) moves
  into the skill for that situation, with a sentence left in the system prompt where the agent needs to know it
  exists.
- One skill per job, named for it and namespaced `dream-…`, instead of one skill for all of `dream`: a turn that sends
  a message reads `dream-chat` (about 2,600 tokens) rather than the whole reference, and each skill fits within what
  compaction keeps.
- Descriptions say what the skill covers and, where it isn't obvious, when to read it, with the key words first, well
  under both harnesses' limits. They stay plain one-line YAML because both adapters write them into `SKILL.md`
  unquoted.
- Skills explain when and why, and leave flags to `dream <command> --help`; every argument now has a description, so
  `--help` and the missing-argument errors say what an id is and where to find it.
- Each thing is said once. Where the system prompt and a skill both covered something (recurring work, the Status
  card's workstream rows, credentials), the detail now lives in the skill.

## Not changed, for evidence first

These would change what the agent does, not where it reads it, so they need a run that shows the effect:

- Anthropic's [Opus 5 guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
  says explicit verification instructions "cause over-verification on Claude Opus 5" and that it "delegates to
  subagents more readily than prior models". Dream asks for separate review subagents and for delegating all
  implementation, which is the founder's choice for quality; whether Opus 5.5 overdoes either in Dream is worth
  measuring with the last-turn cost notes.
- The [Opus 5.5 guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
  finds the model ends unattended turns early with a summary that announces the next step, and that naming those
  stops in the system prompt helps. Dream's turns end when the agent stops; a check of how often turns end that way
  would say whether it's worth a sentence.
- The same guide says a time budget per message makes agent teams finish sooner. Dream's turn prompt has the time but
  not the turn's elapsed time.
- OpenAI's GPT-6 guide suggests telling the model that the person's instructions take precedence over a skill's.
  Dream's skills don't conflict with the person by design, so this matters only if a run shows Codex pausing on one.
