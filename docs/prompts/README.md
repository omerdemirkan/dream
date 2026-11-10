# Dream's prompts

Everything Dream tells the models it runs, in one place. There are two system prompts and a set of skills, each a
directory of sections:

- `system/` is the system prompt of the project's agent, sent on every turn. It holds what the agent needs on every
  turn: who it is, who the person is and what they see, what good looks like, the world it works in, and how it works
  as an orchestrator. It deliberately has no procedures.
- `skills/<name>/` is one skill each (`dream-chat`, `dream-access`, `dream-hosting`, `dream-wake`, `dream-notify`,
  `dream-links`, `dream-machines`, `dream-usage`, and `dream-openai`, which dreamd installs only while Dream's AI
  gateway is on, so the agent hears of the gateway only when it's there): what one part of `dream` does for the person
  and when it's worth using. The harness lists every skill's name and description on every turn, and the agent reads a skill's body when
  it judges it needs it, so detail that matters only in some situations lives here rather than in the system prompt.
  Flags belong to `dream <command> --help`, generated from the CLI's own descriptions (`packages/dreamd/src/Cli.ts`),
  so a skill names a flag where it explains when or why to use it and leaves the full list to `--help`.
- `task/` is the system prompt of a scheduled task's session (`dream wake --task`): a job the agent set up, run in a
  new session of its own from the agent's brief, on the model and effort the agent picked. Like the system prompt, it
  describes the situation and what a good run looks like, and leaves the job itself to the brief. A task's session
  gets the same skills.

Each section is one markdown file with one concern. Its frontmatter's `covers:` line says what it covers and appears
only in the map below; the rest of the file goes into the prompt as written, starting with its heading. The opening
section of each system prompt has no heading; a skill opens with a `#` title. A skill's name and description, which
decide when a model reads it, are in its `frontmatter.yaml`: the description says what the skill covers and when to
read it, with the key words first, since both harnesses shorten descriptions when their list runs long. It stays one
line of plain YAML, because the harnesses write it into `SKILL.md` unquoted.

`bun run sync-prompts` joins the sections, in the order `packages/agent-context/src/sections.ts` lists them, into
`systemPrompt`, `skills` and `taskPrompt` in `packages/agent-context/src/generated/prompts.ts`, which dreamd uses,
and rewrites the map below. A new section is a new file here plus its name in `sections.ts`, where it reads best; a
new skill is a new directory under `skills/` with a `frontmatter.yaml`, plus its entry in `sections.ts`.
`packages/agent-context/test/prompts.test.ts` fails when the generated module or the map is out of date, a file or
skill directory here is missing from `sections.ts`, or a skill's frontmatter wouldn't parse. dreamd hashes the
joined strings, so any change to a section reaches running projects on their next turn
(`packages/dreamd/src/harness/Session.ts`), once a new template build is current. The research behind this layout
is in `docs/research/prompting-guidance.md`.

## What else the agent reads

Not everything the models read is written here. The turn prompt and a few notes are rendered in code:

| Text | Where | Ends up |
| --- | --- | --- |
| The turn prompt: the time where they are, then "What woke you" and each event | `renderTurnPrompt` in `packages/agent-context/src/index.ts`; each event's wording is `renderAgentEvent` in `packages/domain/src/AgentEvent.ts` | The user message that starts each turn (`packages/dreamd/src/Agent.ts`) |
| Events that arrive mid-turn, "This arrived while you were working" | `renderSteerPrompt`, same file | Input to the running turn |
| A task's first message: the time, the agent's reason, and its brief | `renderTaskPrompt`, same file | The user message that starts a task's session (`packages/dreamd/src/Tasks.ts`) |
| "Dream updated its guidance for you", after a prompt or skill change | `renderGuidanceNote`, same file | Before the turn prompt, once, in a Claude Code session (`Session.ts`) |
| The handoff to a new Codex thread after a prompt or skill change | `renderHandoff`, same file | Before the turn prompt in the new thread (`Session.ts`) |
| The handoff into a new conversation on another harness, after they move the project to another plan: the old log, the summary the old harness last compacted to, how it ended | `renderPlanHandoff`, same file | Before the turn prompt in the new conversation (`Session.ts`) |
| The request for a handoff before that move (`PlanSwitching`), and how the move went (`PlanSwitched`: the handoff, the model, the tasks Dream changed, the latest of Chat) | `renderAgentEvent` in `packages/domain/src/AgentEvent.ts` | The outgoing agent's last turn; the new agent's first |
| What Claude Code's `AskUserQuestion` is turned into, and the final-text rule | `packages/dreamd/src/harness/PersonChannel.ts` | Tool results in the session |
| Each skill's name and description, which decide when it gets read | `skills/<name>/frontmatter.yaml` | The harness's list of skills, on every turn |
| Every `dream` command's description, flags and examples | `packages/dreamd/src/Cli.ts` | What `dream <command> --help` prints |

## The map

Every section, in the order it reaches the model, with what it covers and its size in words.

<!-- map: generated by `bun run sync-prompts`; edit the sections, not this -->

### System prompt, 3,438 words

The system prompt of the project's agent, for every turn (`systemPrompt`).

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [(opening)](system/opening.md) | Who you are and what the project you own is, including their experience of it over time. The prompt opens with it, so it has no heading. | 58 |
| 2 | [The person](system/person.md) | Who the person is, how they use Dream, and what helps or discourages them. | 217 |
| 3 | [What they see](system/what-they-see.md) | The app as they see it, Chat, the Status card and Home, and that this session never reaches them. | 195 |
| 4 | [Writing to them](system/writing-to-them.md) | How what you send reads on their phone, and what's worth a recording or a notification. | 222 |
| 5 | [Workstreams](system/workstreams.md) | What a workstream is, how the Status card and Chat show them, and what's worth a message about one. | 173 |
| 6 | [Apps that speak for themselves](system/apps-speak.md) | Notifications the apps you build send under their own name, and when that beats a message from you. | 85 |
| 7 | [What success looks like](system/success.md) | The bar for the finished thing, that large projects taking days or weeks is expected, and that it's judged by how it serves them after it ships. | 120 |
| 8 | [Where you are](system/where-you-are.md) | The sandbox as yours alone, where things are hosted, what reaches beyond it, and the skills and `--help` that describe `dream`. | 165 |
| 9 | [The machine](system/machine.md) | The machine's size and tools, what shares it, and what running out of memory does. | 163 |
| 10 | [Sleep and wake](system/sleep-and-wake.md) | That you don't run continuously, what the sandbox's sleep freezes, and what wakes it. | 142 |
| 11 | [What runs on its own](system/running-on-its-own.md) | The three ways something runs without you (webhooks, scheduled wake-ups, relays), what a schedule costs, and that recurring work costs differently by how it runs. | 296 |
| 12 | [Once it's live](system/once-its-live.md) | What keeping something live working involves, the project's log, and what Dream tells you about, in a sandbox that sleeps. | 186 |
| 13 | [You orchestrate; subagents do the work](system/orchestrating.md) | Why you plan, brief and judge while subagents build, and how background work keeps your turn going. | 242 |
| 14 | [What a step costs](system/step-cost.md) | Why every step re-sends the whole session, what made sessions costly (length, lapsed caches), and the note on the last turn. | 386 |
| 15 | [Choosing a subagent's model and effort](system/subagent-models.md) | Choosing each subagent's model and reasoning effort, what each of the two decides, and what each saves. | 202 |
| 16 | [Reviewing](system/reviewing.md) | Why review goes to separate subagents, and the adversarial review every piece of UI gets before they see it. | 136 |
| 17 | [Offering versions](system/offering-versions.md) | When a choice is theirs to make between real versions, and how to offer them. | 248 |
| 18 | [Credentials](system/credentials.md) | That Dream keeps their credentials out of the sandbox, and what makes a request for one easy to fulfil. | 106 |
| 19 | [Usage](system/usage.md) | Their subscription's limits, what happens when one runs out, deciding with them when it runs low, and the project's own limits. | 96 |

### The `dream-chat` skill, 1,976 words

A skill (`SKILL.md`): the harness lists its name and description on every turn, and the agent or a task's session reads the rest when it judges it needs it.

Its description (32 words, in [frontmatter.yaml](skills/dream-chat/frontmatter.yaml)): Sending the person anything with `dream` — messages, notifications, email, questions and versions to choose between, thread replies, the Status card, workstreams and Live Activities, and how each shows on their phone.

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [Talking to them through Dream](skills/dream-chat/chat.md) | What reaches them through `dream`, that it works from any process here, and where the flags are listed. | 61 |
| 2 | [Messages](skills/dream-chat/messages.md) | `dream message`: what Chat renders, attaching media, notifying, withdrawing a notification, and the files they attach. | 229 |
| 3 | [Email](skills/dream-chat/email.md) | `dream email`: emailing them markdown you write, what the email looks like, the copy in Chat, and its limits. | 202 |
| 4 | [Questions](skills/dream-chat/questions.md) | `dream ask`: the question card, options with screenshots, recordings or audio, answers, and withdrawing. | 479 |
| 5 | [Threads](skills/dream-chat/threads.md) | Threads: their replies on any message, `--reply-to`, when a thread reply beats a new message, and `dream ask revise`. | 330 |
| 6 | [The Status card](skills/dream-chat/status.md) | `dream status`: the now sentence, milestones and their needs, media, and how the project shows on Home. | 228 |
| 7 | [Workstreams](skills/dream-chat/workstreams.md) | `dream work`: starting, updating, finishing and dropping workstreams, labelling what you send, and routing their messages. | 393 |
| 8 | [Live Activity](skills/dream-chat/live-activity.md) | `dream live`: a Live Activity on their lock screen and Dynamic Island. | 54 |

### The `dream-access` skill, 1,169 words

A skill (`SKILL.md`): the harness lists its name and description on every turn, and the agent or a task's session reads the rest when it judges it needs it.

Its description (38 words, in [frontmatter.yaml](skills/dream-access/frontmatter.yaml)): Asking the person for access to a service with `dream access` — Google and OAuth sign-ins, API keys Dream adds to your requests, App Store Connect for TestFlight, and key files. Read it before asking for any credential.

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [Access to services](skills/dream-access/access.md) | `dream access`: how Dream keeps their credentials out of the sandbox, the access card and what makes it quick to fulfil, each kind (Google, OAuth providers, keys in a header, Apple, key files), and connections over time. | 1169 |

### The `dream-hosting` skill, 1,018 words

A skill (`SKILL.md`): the harness lists its name and description on every turn, and the agent or a task's session reads the rest when it judges it needs it.

Its description (38 words, in [frontmatter.yaml](skills/dream-hosting/frontmatter.yaml)): Serving what you build — `dream publish` for a public URL that wakes the sandbox, webhooks, servers that stay up between turns, `dream relay` for Discord's Gateway or WebSocket feeds while the sandbox sleeps, and outgrowing the sandbox.

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [Hosting](skills/dream-hosting/hosting.md) | `dream publish`: the public URL, how it wakes and checks the sandbox, webhooks, and keeping servers running between turns. | 360 |
| 2 | [Relays](skills/dream-hosting/relays.md) | `dream relay`: Discord's Gateway and WebSocket feeds held open by Dream, how events reach your app, signatures, state, and limits. | 606 |
| 3 | [If it grows](skills/dream-hosting/if-it-grows.md) | What changes if a project outgrows the sandbox and has to serve many people. | 52 |

### The `dream-wake` skill, 736 words

A skill (`SKILL.md`): the harness lists its name and description on every turn, and the agent or a task's session reads the rest when it judges it needs it.

Its description (42 words, in [frontmatter.yaml](skills/dream-wake/frontmatter.yaml)): Scheduling with `dream wake` — wake-ups and commands at a time or on cron, scheduled tasks in a session of their own, what wakes you, and what recurring work costs as a turn, a task or an app calling a model API.

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [Waking](skills/dream-wake/waking.md) | `dream wake`: what wakes you, scheduled wake-ups and commands, scheduled tasks, waking you now, and listing or cancelling. | 560 |
| 2 | [Recurring work](skills/dream-wake/recurring-work.md) | What recurring work costs as a turn, as a scheduled task, or as an app calling a model API, and who weighs it. | 176 |

### The `dream-notify` skill, 539 words

A skill (`SKILL.md`): the harness lists its name and description on every turn, and the agent or a task's session reads the rest when it judges it needs it.

Its description (32 words, in [frontmatter.yaml](skills/dream-notify/frontmatter.yaml)): Letting an app you build notify the person under its own name with `dream notify` — asking them to allow it, sending, replacing or quieting its notifications, their controls and Dream's limits.

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [Notifications from your apps](skills/dream-notify/notify.md) | `dream notify`: what makes an app's notifications worth keeping on, readying an app to notify them, sending as the app, their controls and Dream's limits, and the history. | 539 |

### The `dream-links` skill, 520 words

A skill (`SKILL.md`): the harness lists its name and description on every turn, and the agent or a task's session reads the rest when it judges it needs it.

Its description (32 words, in [frontmatter.yaml](skills/dream-links/frontmatter.yaml)): Putting what you built on the person's Dream Home as an app icon with `dream link` — the tile, its title and icon, their edits, Add to Home Screen and share previews.

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [App links on their Home](skills/dream-links/links.md) | `dream link`: the row of app icons on their Home, what a tile shows, their edits, Add to Home Screen, and sharing. | 520 |

### The `dream-machines` skill, 837 words

A skill (`SKILL.md`): the harness lists its name and description on every turn, and the agent or a task's session reads the rest when it judges it needs it.

Its description (34 words, in [frontmatter.yaml](skills/dream-machines/frontmatter.yaml)): This sandbox's size and moving to a larger one (`dream machine`), the local Chromium and Playwright, a real Chrome in the cloud (`dream browser`), and renting a Mac with Xcode and simulators (`dream mac`).

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [Machines](skills/dream-machines/machines.md) | What the skill covers: this machine's sizes, the browsers, and the Mac. | 35 |
| 2 | [This machine](skills/dream-machines/machine.md) | `dream machine`: which size this is, when to move between sizes, and what a move carries over. | 201 |
| 3 | [Browsers](skills/dream-machines/browsers.md) | The local headless Chromium and Playwright, and `dream browser` for a real Chrome in the cloud. | 159 |
| 4 | [A Mac](skills/dream-machines/mac.md) | `dream mac`: renting a Mac with Xcode and simulators, running commands, copying files, and what's on it. | 442 |

### The `dream-usage` skill, 231 words

A skill (`SKILL.md`): the harness lists its name and description on every turn, and the agent or a task's session reads the rest when it judges it needs it.

Its description (31 words, in [frontmatter.yaml](skills/dream-usage/frontmatter.yaml)): The person's plan with `dream usage` — five-hour and weekly windows, this project's share of the week, the limits they set on it, and what Dream holds back at a limit.

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [Usage](skills/dream-usage/usage.md) | `dream usage`: their subscription's windows, this project's share of the week, the limits they set on it, and what Dream paid to run it. | 231 |

### The `dream-openai` skill, 338 words

A skill (`SKILL.md`): the harness lists its name and description on every turn, and the agent or a task's session reads the rest when it judges it needs it.

Its description (41 words, in [frontmatter.yaml](skills/dream-openai/frontmatter.yaml)): Dream provides OpenAI's API to this project's apps and pays for it — text, speech, realtime voice, images, embeddings, transcription — with no key to ask them for. Read it before an app calls OpenAI or needs a model API key.

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [OpenAI through Dream](skills/dream-openai/gateway.md) | OpenAI's API through Dream for the apps you build: the variables, what's there and what isn't, browsers and realtime voice, and what it costs whom. | 338 |

### Task prompt, 432 words

The system prompt of a scheduled task's session, `dream wake --task` (`taskPrompt`).

| # | Section | Covers | Words |
| --- | --- | --- | --- |
| 1 | [(opening)](task/opening.md) | Who you are in a task's session, who scheduled the job, and what you know of the project. It opens the prompt, so it has no heading. | 66 |
| 2 | [Why you're on your own](task/on-your-own.md) | Why the job runs in a fresh session, what it costs them, and keeping to the brief. | 97 |
| 3 | [Nobody is watching](task/nobody-watching.md) | That nobody sees the session, so the job is yours to finish, and what to do when the brief is wrong. | 60 |
| 4 | [Reaching them, and the agent](task/reaching-them.md) | When to send the person something, and when and how the agent gets woken. | 117 |
| 5 | [Your report](task/report.md) | What your last message, the report for the agent, holds, and when it gets read. | 50 |
| 6 | [The sandbox](task/sandbox.md) | Sharing the machine with the person's app and the agent. | 42 |

<!-- /map -->

## Found while restructuring

Left as they were, for review:

- The system prompt's Offering versions and `dream-chat`'s Questions both describe offering versions, from two
  sides: the prompt says when and why, the skill how `--show` displays them and that a subagent per option in its own
  worktree makes them cheap. They agree, but a change to one is likely to need the other.
- The system prompt's What a step costs and `dream-machines`' A Mac both explain waiting in rounds of a few minutes
  to keep a session's cache; the skill is what a subagent waiting on the Mac reads.
