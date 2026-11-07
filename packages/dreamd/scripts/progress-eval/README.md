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
| `cli-replay.ts` | The model-backed line: the recorded turns through the real pinned CLI (`claude -p --model haiku`, `codex exec -m gpt-6-luna`) exactly as `src/progress/CliSummarizer.ts` calls it, side by side with the model-free line, with each call's tokens. Against the fake servers, or a real provider inside a sandbox. |
| `compare.ts` | The same windows through the providers' APIs on Dream's own operator keys (never a person's subscription). Not run. |

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

## Model-backed, through the harness CLI (7 November 2026)

With `DREAM_PROGRESS_LINE=on`, dreamd asks the provider's cheapest current model for the line through the project's
own harness CLI, on the login the agent already uses (`src/progress/CliSummarizer.ts`): `claude -p --model haiku`
(claude-haiku-5-5 in Claude Code 2.1.318) or `codex exec -m gpt-6-luna` (Codex 0.165.0), both at low effort. It sees
only the window (`src/progress/Window.ts`: what started the turn, how long it's run, the line on screen, the last ten
steps; at most 3,000 characters), never the conversation. A call is made at most every two minutes, only while
someone watches and the work moved on; the model line stays up until the next call replaces it. The model-free line
stands in before the first call, when a call fails, takes more than 25 seconds, or answers with something that
doesn't fit one line or reads like code.

### What one call sends

Measured by pointing the real pinned CLIs at the fake servers (`fake-anthropic.ts`, `fake-responses.ts` log each
request's size):

- **Claude Code**: one request, about 4.5 KB. Dream's prompt replaces Claude Code's (`--system-prompt`), with no
  tools (`--tools ""`), no settings, MCP servers, slash commands or session file. What the CLI still adds: a billing
  header, a one-line agent preamble and an environment block (about 250 tokens). `--bare` would drop more, but it
  refuses subscription logins.
- **Codex**: one request, about 27 KB. Dream's prompt replaces Codex's base instructions (`model_instructions_file`),
  and every optional tool and instruction block that can be switched off is off. What's left: 18 KB of tools
  gpt-6-luna keeps whatever the config says (its code-running tool and the multi-agent tools) and 6 KB of skills and
  multi-agent text. That's about 7,000 tokens a call, 25 KB of it the same every time, so mostly cached.

### A real check

Five calls on a throwaway QA project (deleted afterwards), Claude Code on the founder's login, on five of the recorded
windows:

| Moment | Model-backed (Haiku 5.5) | Model-free |
| --- | --- | --- |
| Morning Build, 6 min | Fixing the link decoding and topic clustering | Checking the font |
| Morning Build, 16 min | Adjusting the sting level and re-rendering | Checking the intro phrasing |
| Voice Tutor, 8 min | Opening db.py to check the sqlite layer | Checking the scheduling states |
| Voice Tutor, 20 min | Writing a correct endpoint for regrading cards | Changing the test to wait |
| Voice Tutor, 32 min | Stopping the mock server and cleaning up | Checking how the sūrah name is laid out |

Each call: 1,200 to 1,370 input tokens and 16 to 18 output tokens, 1.2 to 2.9 seconds, $0.00025 to $0.00028 at
list prices by Claude Code's own count. One line ("Opening db.py…") names a file, which the presentability check
would have refused, so on screen the model-free line would have stayed.

### What it costs the person

The recorded turns on Claude: the 36-minute Voice Tutor turn cost $13.76 at list prices and moved the weekly window
from 34% to 36%; the 26-minute Morning Build turn cost $5.08. Across the ledger's turns with readings, a dollar of
list-price use is about 0.35% of the founder's weekly window.

Watched from start to end, the 36-minute turn gets about 18 calls (one per two minutes): about 23,000 Haiku input
tokens and 300 output, about $0.005. That's 0.03% of the turn's own cost, or about 0.002% of the week. Nobody
watching, nothing is called. On Codex the calls are heavier (about 7,000 tokens, mostly cached prefix, at
gpt-6-luna's $0.10 in and $0.50 out per million tokens: under $0.001 a call uncached), still a rounding error next
to a gpt-6.1-sol turn; there's no ChatGPT account connected to measure a real one.
