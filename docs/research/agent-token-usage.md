# Where the agent's tokens go (research, 2026-11-06)

The question: why did two of the founder's Claude Code projects use so much of his Max plan, and how can the agent
spend less without doing worse work?

Sources: Dream's turn ledger (D1 `turn_usage`, read 2026-11-06 23:30 UTC) and the Claude Code transcripts in both
sandboxes (`~/.claude/projects/-home-user-project/<session>.jsonl` and `<session>/subagents/agent-*.jsonl`), read
through envd. The Voice Tutor sandbox was only read. The Morning Build sandbox was resumed to read it and paused
again. Each API call was counted once (Claude Code writes one transcript line per content block, all with the same
usage). Costs are at list prices (Opus 5.5: $4 input, $20 output, $0.20 cache read, cache writes 1.25× input for
5 minutes and 2× for 1 hour; Sonnet 5.5: $2, $10, $0.20; Haiku 4.5: $1, $5, $0.10). The recomputed totals match
the ledger's `cost_usd` ($5.10 against $5.08, $13.68 against $13.76). How Claude's limits weigh these tokens isn't
published, so list price stands in for it here, as it does in `apps/api/src/usage/Shares.ts`.

## Summary

- **Cost per step is the size of the session, and sessions got big.** Each step re-sends everything its session
  holds. The Morning Build's top level took 76 steps averaging 135k tokens of context. Voice Tutor's two subagents
  took 98 and 72 steps averaging 139k and 120k. Tool outputs were small throughout. The agent piped builds and logs
  through `tail` and polled sparingly. What filled the context was the work itself: the code it wrote (Write
  inputs and output), the files it read, and its reasoning.
- **Hypothesis 1 (the top level does everything) holds for the Morning Build.** The top level spent 95% of the
  turn ($4.87 of $5.10). Its one subagent, on Sonnet at medium effort, set up local TTS for $0.23.
- **For Voice Tutor it's the other way round, and hypothesis 2 is what matters.** The top level spent 13% ($1.77)
  and delegated both workstreams. It started both subagents on `opus` at `high`, and each ran a whole workstream
  in one session for 20–30 minutes: research, writing every file, tests, screenshots and fixes. Together they
  spent $11.91.
- **A cheaper model alone saves less than it seems.** Opus 5.5 and Sonnet 5.5 cost the same for cache reads
  ($0.20/M), and reads were 39–41% of each turn. Moving the Voice Tutor subagents to Sonnet would have cut output
  and cache writes in half, about 31% of their cost. Keeping each subagent's session short saves as much again.
- **One skill load cost a fifth of a turn.** The Morning Build's top level loaded Claude Code's bundled
  `claude-api` skill (about 44k tokens) to decide how the app would write scripts. That text rode along on the
  next 70 steps: $0.97, 19% of the turn. It stays in the session, and is paid for on every step, until the session
  compacts.
- **The Morning Build was designed to cost that much every day.** The agent chose to write each episode itself, in
  a morning turn of the project's own session (`dream wake --cron` with no `--run`). With a ~210k-token session,
  that's about $3–4 an episode. That would have been roughly 3–6 points of the weekly limit a week, from one
  podcast. The founder then made it weekly.
- **The 5-point jump wasn't Dream's.** The ledger's "before" for the Morning Build's first turn was a reading from
  17:07, four hours before the turn started. Dream turns over the next two hours cost about $4–8 per point, so
  that turn's $5.08 was roughly 1 point. The other ~4 points most likely came from the founder's own Claude use
  between 17:07 and 21:09.

## The ledger

| Project | Turn (UTC) | Cache read | Cache write | Output | Cost | Weekly before → after (reading time) |
| --- | --- | --- | --- | --- | --- | --- |
| The Morning Build | 21:09–21:36 | 10.40M | 219k | 77k | $5.08 | 28% (17:07) → 33% |
| | 21:36–21:37 | 1.03M | 3k | 1.5k | $0.26 | 33% → 33% |
| | 22:28–22:31 | 1.92M | 14k | 7.1k | $0.64 | 33% → 34% |
| | 22:31–22:32 | 1.34M | 5k | 2.8k | $0.36 | 34% → 34% |
| | 22:32–22:33 | 0.45M | 1k | 0.6k | $0.11 | 34% → 34% |
| Voice Tutor | 22:36–22:41 | 1.11M | 89k | 23k | $1.28 | 34% → 34% |
| | 22:41–22:43 | 0.60M | 15k | 8.3k | $0.38 | 34% → 34% |
| | 22:50–23:27 | 26.66M | 477k | 290k | $13.76 | 34% → 36% |

The five-hour window is null in every row: dreamd got no five-hour reading from Claude Code on this plan, so
Dream can't attribute that window at all. That's worth a look on its own.

The later Morning Build turns were small, but each re-read the session: about 200k tokens a step. Changing the
podcast to weekly took 1.9M tokens of reads for a few edits.

## Where the tokens went

### Top level against subagents (the two big turns)

| Session | Model, effort | Steps | Avg context | Cache read | Cache write | Output (thinking) | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Morning Build, top level | Opus 5.5, high | 76 | 135k | 10.22M | 192k (1h) | 64k (17k) | $4.87 |
| Morning Build, "Set up local Kokoro TTS" | Sonnet 5.5, medium | 11 | 16k | 0.17M | 27k | 13k (1k) | $0.23 |
| Voice Tutor, top level | Opus 5.5, high | 45 | 97k | 4.36M | 54k (1h) | 23k (6k) | $1.77 |
| Voice Tutor, "Build voice frontend + realtime" | Opus 5.5, high | 98 | 139k | 13.65M | 235k | 144k (38k) | $6.78 |
| Voice Tutor, "Build Anki backend + Terra grader" | Opus 5.5, high | 72 | 120k | 8.65M | 188k | 123k (43k) | $5.14 |

By kind of cost: Morning Build $2.08 reads, $1.61 writes, $1.41 output. Voice Tutor $5.33 reads, $2.55 writes,
$5.80 output.

Context grew from the first step to the last: the Morning Build's top level from 19k to 204k, the Voice Tutor
subagents from 13k to 242k and 188k. The Voice Tutor top level started its turn at 70k, carried over from its
earlier turns.

### By kind of step

Each step's cost is credited to the tools it called (split evenly when it called several).

| Step | Morning Build top | Morning Build subagent | Voice Tutor top | Voice Tutor subagents |
| --- | --- | --- | --- | --- |
| Writing code (Write, Edit, scripted edits) | 18 steps, $1.49 | 3, $0.10 | 6, $0.28 | 76, $7.19 |
| Running and probing (scripts, curl, servers) | 18, $1.02 | 5, $0.07 | 2, $0.11 | 30, $1.80 |
| Reading files and code | 12, $1.07 | — | 11, $0.36 | 20, $1.01 |
| `dream` (status, messages, wakes, links) | 14, $0.61 | — | 13, $0.42 | 3, $0.08 |
| Browser and screenshots | 4, $0.15 | — | 6, $0.17 | 12, $0.57 |
| Builds and tests | 1, $0.05 | — | 2, $0.07 | 10, $0.52 |
| Web research (WebFetch, WebSearch) | — | — | 1, $0.02 | 12, $0.32 |
| Waiting loops | 2, $0.11 | — | 2, $0.14 | 2, $0.10 |
| Delegating and coordinating | 2, $0.08 | 1, $0.01 | 1, $0.13 | 2, $0.11 |
| Installs, skills, final reply | 6, $0.29 | 2, $0.06 | 1, $0.06 | 2, $0.21 |

No step type is cheap at 135k of context. In the Morning Build, writing code, running it and reading files cost
about the same per step, because each step's price was mostly the session it carried.

### What was not the problem

- **Tool output.** Results over the whole Voice Tutor turn came to about 450k characters (≈130k tokens), and the
  Morning Build's to about 190k. The biggest single results were a 66k-character `Read` of the day's news
  candidates and an 18k-character `sed` of another agent's file. Builds and tests were piped through `tail`.
  Carrying every tool result on later steps cost about $1.2 of the Voice Tutor turn (9%) and $0.4 of the Morning Build's (7%).
- **Polling.** Waiting was a handful of steps per turn (`until … sleep`, `while pgrep … sleep 5`, Monitor). The
  harness doesn't call the model while a shell loop runs.
- **Screenshots.** About 20 in the frontend subagent, ≈1.5k tokens each: around $0.2 carried.
- **Thinking.** 26–35% of output, so 5–14% of a turn. At the top level it was small: 17k tokens in the Morning
  Build, 6k in Voice Tutor.
- **Cache misses.** Subagents use 5-minute cache writes and the top level 1-hour ones (Claude Code's default on a
  subscription). There were no mid-turn misses. The Morning Build's turns 52 minutes apart still read from cache.

### Smaller findings

- **Background subagents died with their turns.** In Voice Tutor's first turn the agent started both builders in
  the background and ended the turn 90 seconds later, and the CLI stopped them. It resumed them with
  `SendMessage` in the next turn, which also ended before they finished. About $0.45 of subagent work was lost,
  and the third turn briefed them again from scratch, in the foreground. The prompt said a subagent "can be"
  stopped. It always is (verified-facts, "Agent fleet").
- **Claude Code's own Agent tool argues against delegating.** "A fresh agent costs more than it looks… When in
  doubt, don't spawn." On `effort` it says to set it only when instructions ask for it. Dream's prompt has to
  outweigh that, and it gave no reason in cost terms.
- **Why Opus/high for the Voice Tutor builders.** The agent was following the prompt: "deep knowledge, decisions,
  and intricate work need a stronger one; work that must not miss anything needs more [effort]." Both builds
  looked intricate to it, and nothing in the prompt said what the stronger choice costs.

## What would have helped, and what it's worth

Estimates apply each change to the transcripts above. Splitting one session into k pieces is modelled as each piece
starting at 20k tokens (brief plus a handoff) and growing as the original did, plus 20% for re-reading files a
fresh session needs. Before that allowance, it cuts reads in the three long sessions by about half for k = 2 and about 60% for k = 3.

### 1. Prompt: say what a step costs (on the branch)

The system prompt (now `docs/prompts/system/step-cost.md`) explains the mechanics: every step re-sends the session, the top-level session lives as
long as the project, and anything read into it is paid for on every later step. The work goes to subagents. Each
subagent gets a piece that finishes rather than a whole workstream. A smaller model does the same steps for a
fraction of the cost, and less effort means fewer, shorter steps. It also says plainly that a subagent still running
when the turn ends is stopped. Usage adds that a recurring turn costs the whole session each time, and the skill's
`dream wake` text says the same. Everything is context and reasons, the same for Claude Code and Codex, with no
model names.

Estimated effect, if the agent follows it the way the transcripts suggest it would:

- **Morning Build first turn: $5.10 → about $2.75 (−46%).** The top level keeps about 25 steps (plan, questions,
  `dream`, wakes, review) at about 45k context: ≈$1.0. Pipeline code, TTS tuning and the sample script go to
  Sonnet subagents in about three pieces (≈55 steps, ≈3.7M reads, ≈200k writes, ≈50k output): ≈$1.75. The
  `claude-api` skill, if loaded at all, would land in a subagent.
- **Voice Tutor big turn: $13.68 → about $8 (−40%).** The builders on Sonnet at medium, each in about three pieces:
  reads 22.3M → ≈11M ($4.46 → $2.22), writes ≈540k at Sonnet prices ($2.11 → $1.36), and output at half price
  with less thinking ($5.34 → ≈$2.27). The top level gains a little reviewing ($1.77 → ≈$2.3). If the realtime
  voice client, the most intricate piece, stays on Opus, it's nearer −30%.
- **Quality.** Judgment stays at the top level, which still runs on Opus at high effort and reviews each piece.
  The pieces that need knowledge and judgment can still go to Opus. What moves to the smaller model is building to
  a brief the top level has already thought through.

### 2. Bound the top-level session: `autoCompactWindow: 300000` (on the branch, separate commit)

Claude Code's auto-compact window defaults to "auto", the window tuned for each model. For Opus 5.5, which reports
1M, that may be close to the whole window (the choice comes from client data and experiments, so it can't be
read from the binary). Dream's session lives for weeks, so the cost of each step tends toward the window:

| Session size | Re-read per step | First step after an hour asleep (1-hour cache write) |
| --- | --- | --- |
| 200k | $0.04 | $1.60 |
| 300k | $0.06 | $2.40 |
| 950k | $0.19 | $7.60 |

dreamd now writes `autoCompactWindow: 300000` into `~/.claude/settings.json` (`Fleet.ts`, `PersonChannel.ts`). It
had no effect on these turns: the largest session was 242k. What it costs: past 300k the agent works from a summary
instead of the full history. The project's files, git, and the agent's memory files hold what matters, and the
prompt change keeps the top level well under it in the first place. This partly undoes the 1M-context decision for
Claude Code, so it's a separate commit and easy to drop. Codex has the same shape (`model_context_window` is 1M,
and the auto-compact limit follows it). `model_auto_compact_token_limit = 300000` would be the equivalent, but it
isn't on the branch because it hasn't been checked against a Codex build (check it with
`packages/dreamd/scripts/fake-responses.ts`).

### 3. Recurring model work out of the project's session (prompt on the branch; product idea not built)

The Morning Build agent weighed an API key against writing each episode itself. It chose itself because it had no
key and didn't know what a turn costs. As designed, each 4:15 wake would start a turn in a session of ~210k
tokens:

- Re-cache the cold session: ≈$1.70.
- About 25 steps at ~250k: ≈$1.25.
- Read ~60k tokens of articles and write the script: ≈$0.70.

That's $3–4 an episode and $25 a week, or 3–6 weekly points a week at today's rate. An app calling Sonnet with
their key would spend about $0.15–0.30 an episode, outside their plan. The prompt now gives the agent that
trade-off to put to the person.

A product change would do more: a scheduled task that runs in a fresh, small session on a model the agent picks
(say `dream wake --cron … --task "…" --model small`), reporting back to the project's session only when something
needs it. That would cost about a subagent's $0.5 an episode. It isn't built, because it changes dreamd's turn
model.

### 4. Ledger attribution: take "before" at the turn's start (not built)

`turnStarted` in `SandboxManager.ts` uses the latest stored snapshot as "before". dreamd reports usage only after a
turn, so after a quiet spell the reading can be hours old, and the founder's own use in between is credited to the
next turn. `Shares.ts` documents this. The fix is small:

- dreamd reports usage as soon as the turn's first `rate_limit_event` arrives (one model call into the turn).
- `SandboxManager` replaces `turnUsageBefore` with that reading when the stored one predates the turn's start by
  more than about ten minutes.

The first call's own use is then lost to "Outside Dream", a fraction of a point at most.

### Considered and left alone

- **Top-level model and effort (`Fleet.ts`).** Unchanged. The top level's cost was its context length, not its
  reasoning (6–17k thinking tokens a turn), and it's where quality is decided.
- **A default subagent model (`CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_SUBAGENT_EFFORT`).** The CLI supports it,
  but both agents set `model` and `effort` on every call, so a default would have changed nothing, and it would
  quietly override the agent's choice whenever it left one out.
- **Prompt cache TTL (`promptCacheTtl`, `subagentPromptCacheTtl`).** Keep 1 hour for the top level and 5 minutes for
  subagents. The 1-hour premium cost $0.58 of the Morning Build turn, but a single miss on a 200k session costs
  $1.00 to re-cache, and Dream's turns often come within the hour.
- **Disabling the `claude-api` skill.** It's useful when an app is built on Claude. The prompt change gives the
  reason to read heavy references in a subagent instead.
- **`BASH_MAX_OUTPUT_LENGTH` and file-read limits.** Outputs were already small.
- **The turn prompt (`renderTurnPrompt`).** A few hundred tokens: the time and the events. Nothing to cut.

# Follow-up: a day of building (2026-11-08)

Anki Voice (`prj_fc22f93d…`, an iPhone app with CarPlay, built on the Mac) and Arabic conversation partner
(`prj_50afbb83…`, a web app), from the transcripts in both sandboxes (copied out read-only, 18:46 Nov 7 to 05:27
Nov 8 UTC) and `turn_usage`. Same method and list prices as above. Anki Voice: 1,203 steps, $71.8. Arabic: 387 steps,
$18.4. The weekly window went from 49% to 55% while both worked (20:54–04:51), about $13 of list-price use a point;
that's lower per dollar than the Nov 6 turns ($4–8), so the ratio isn't stable enough to put in the prompt.

## Where it went

- **Subagents, not the top level.** Anki Voice's top level spent 10% ($7.0, 129 steps, context up to 182k), Arabic's
  17%. The earlier finding (the top level doing the work) didn't recur.
- **Long subagent sessions.** Eight Anki Voice subagents ran 60–150 steps each, six of them past 200k tokens: 79% of
  the day. A step cost $0.029 under 50k of context, $0.064 at 100–200k and $0.112 past 200k. Two sessions were sent
  their next round (review findings, "resume after a time limit") with `SendMessage` and kept growing (the design
  session reached 257k over 151 steps).
- **Cache lapses while waiting on the Mac: 20% of Anki Voice's day ($14.5).** Subagents' cache writes are 5-minute
  (top level: 1-hour). Builds, tests and screenshot runs on the Mac took 5–10 minutes, waited on with
  `until dream mac ssh -- 'grep -q DONE …'; do sleep …; done`, so the next step re-wrote the whole 100–250k session at
  1.25× input instead of reading it at 0.1×: 27 times in subagents, up to $1.28 a step on Opus. Arabic (no Mac): $1.1,
  6%. Waiting in rounds under four minutes would have cost about $1.1 instead of $13. A 1-hour subagent TTL would save
  $6.9 net on Anki Voice but cost $1.7 more on Arabic (all writes at 2× instead of 1.25×), so it wasn't changed.
- **By kind:** Anki Voice 39% cache reads, 38% cache writes, 24% output; Arabic 40%, 27%, 32%. Reasoning was ~40% of
  the builders' output at high effort (29% at medium).
- **Models.** Anki Voice: Opus/high subagents (three design directions, adopting one, UI fixes, code review) $36.1,
  Sonnet/high $25.4, Sonnet/medium $2.2, Opus/medium reviewers $1.0. Arabic: Sonnet/high builders $12.6.
- **Offering versions.** One Opus/high session built and shot all three design directions ($11.3); with the review and
  fixes the round came to about $15.6. Adopting the pick app-wide and two fix rounds cost another $20.
- **Screenshots** (189 in Anki Voice, ≈2,500 tokens each; ≈1,700 for web pages): about 5%. **Whole files read** at the
  start of fix-up sessions (several 20–30k-character `cat`s, carried 80–130 steps): 11–13%.
- **Dream's 3-hour limit** stopped two Anki Voice turns with subagents mid-work; the agent restarted them from WIP
  commits. The progress line (Haiku) was 15 calls, negligible.

## What changed

- `system/step-cost.md`, `system/subagent-models.md`, `skill/mac.md` (waiting on the Mac), and the cost of a round of
  versions in `system/offering-versions.md`, with the magnitudes above.
- The agent couldn't see any of this: `dream usage` shows only the subscription's windows. Each turn's prompt now opens
  with what the last turn used (`renderLastTurn` in `@dream/agent-context`, from `TurnUsage.settle` in dreamd): its
  cost at list prices, the weekly window's movement, and each session's share, steps and largest context, with the
  share lost to lapsed caches when it's over 10%. Replayed on Anki Voice's 00:01–03:06 turn it reads: "Your last turn
  ran 3 h 5 min and came to about $29 at API prices. … Subagents: "Fix final UI review findings" (opus, high) 34%,
  101 steps, up to 258k; … About 32% of it went to sending sessions afresh after a pause had let their cache lapse."

## Also seen

- `turn_usage.cost_usd` is null for turns Dream stopped at its 3-hour limit (the stream ends without a `finish`, so no
  running cost), and the next turn's rise then covers all of them ($62.73 on Anki Voice's 03:06 turn). `Shares.ts`
  falls back to token weights when a group lacks costs, so the shares hold; the per-turn dollar figure doesn't.
