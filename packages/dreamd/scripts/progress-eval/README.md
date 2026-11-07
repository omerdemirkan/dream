# Progress line evaluation

How good is the line under "Working" when it's made without a model? These scripts replay real recorded turns
through dreamd's progress code, exactly as a phone watching the whole time would have seen it, and score every line.

| File | What it does |
| --- | --- |
| `extract.ts` | Turns recorded Claude Code sessions (and their subagents') into `test/fixtures/progress/*.json`: every turn of three minutes or more, as timed stream parts, with commands cut to their first plain words, tool output dropped, web fetches reduced to the host, and emails, long tokens and URL queries blanked. |
| `transcript.ts`, `fixtures.ts` | Read a session transcript, or the fixtures, as the parts dreamd's harness adapter delivers (subagent messages as `raw` parts, as with `forwardSubagentText`). |
| `replay.ts` | Runs a turn the way `src/progress/Progress.ts` does: a check every 10 seconds, a new line only when the work moved on, at most once a minute, held at least two minutes unless something bigger replaces it. |
| `criteria.ts` | What a script can check (below). |
| `eval.ts` | The model-free lines, turn by turn, with flags and totals. `test/progress.test.ts` holds them to the bar. |
| `prompt.ts`, `compare.ts` | The same windows through Haiku 5.5 and gpt-6-luna, on Dream's own operator API keys only (never a person's subscription). Not run yet. |

```sh
node packages/dreamd/scripts/progress-eval/eval.ts
ANTHROPIC_API_KEY=… OPENAI_API_KEY=… node packages/dreamd/scripts/progress-eval/compare.ts --out report.json
```

## What good looks like

Checked by script, on every line:

- **Fits**: one line on the smallest iPhone, at most 276 pt at 14 pt (about 42 characters of prose; see
  `src/progress/Line.ts`). Never cut to fit.
- **Clean**: no code, file names, paths, flags or identifiers; nothing about the machinery (agents, sessions,
  tokens, prompts); nobody unclear ("them"); no phrase left hanging ("Checking that the router sits").
- **Voice**: starts with an -ing verb, the "I'm" left out; no "I", no full stop, no quotes.
- **Grounded**: shares a word with the window's steps. A derived line can't invent anything; the few misses are
  phrases taken from a later sentence of a thought the window shows clipped.
- **Jargon**: all-caps abbreviations and words with digits, counted rather than failed.

And over each turn: **coverage** (how much of it, after the first minute, had a line on screen) and **churn** (changes
per ten minutes; more than about five reads as noise).

For a person to judge, since a script can't: is it **accurate** (what the agent was really doing then), **specific**
(names the real thing), **plain** (words the person uses), **calm** (no alarm, no cheer)?

## Results, model-free (7 November 2026)

Three recorded turns of three minutes or more, from Voice Tutor and The Morning Build (both Claude Code), 66 minutes
in all. 29 lines: all fit, all clean, all in voice; 10% carry an abbreviation or a number. A line was on screen for
100% of each turn after its first minute, changing 4.5 times per ten minutes.

Voice Tutor, the 36-minute turn the founder watched (most of it a 30-minute wait on two subagents building the
backend and the voice app):

```
  1m  Routing grading
  3m  Building voice frontend and realtime
  7m  Checking the scheduling states
  9m  Switching to the system CA bundle
 11m  Setting up the configs
 13m  Checking the filename transformations
 15m  Setting up the app factory
 17m  Rendering the PNG icons
 19m  Changing the test to wait
 21m  Using a pid file instead
 23m  Checking the remaining states now
 25m  Disabling certificate checks
 27m  Running the full app UI
 29m  Checking the sūrah card's Arabic verses
 31m  Checking how the sūrah name is laid out
 33m  Restarting the server
 35m  Checking the status refresh
```

The Morning Build, 26 minutes:

```
  1m  Pricing this out
  3m  Choosing a default commute
  5m  Checking the font
  7m  Planning to add tech terms like GPT
  9m  Adding normalization rules for tech terms
 12m  Starting with a quick check
 14m  Checking the intro phrasing
 17m  Dropping the episode number
 24m  Running the kill separately from the check
 26m  Adding the link to Home
```

Where the lines come from: almost all are the first clause of a summarized thought, the agent's or a subagent's
("Now I'm setting up the app factory, which…"). The top-level agent left every shell command's `description` empty
in both sessions; its subagents filled them in. Without subagent thinking (Claude Code's default, before
`forwardSubagentText`), the Voice Tutor line sits on "Building voice frontend and realtime" for nine minutes and the
rest come from command descriptions, more technical ("Writing tsconfig and vite config", "Resetting queued create
flag on send").

What a model-free line can't do: explain why ("the first version let most slips through"), or turn developer words
("pid file", "CA bundle", "app factory") into the person's. That's what `compare.ts` would show a model adding.
There's no recorded Codex turn yet; Codex's reasoning summaries (with their bold headings) feed the same path.
