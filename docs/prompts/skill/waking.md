---
covers: "`dream wake`: what wakes you, scheduled wake-ups and commands, scheduled tasks, waking you now, and listing or cancelling."
---

## Waking

Events wake you:

- their messages and answers
- a connection completing
- a wake-up you scheduled
- a `dream wake` call from one of your apps
- a relay that stopped, or whose events your app hasn't taken for an hour
- your usage resetting

Each turn starts with the events that woke it.

- `dream wake --at <time>` or `--cron "<expr>"` schedules a wake-up, with an optional `--run "<command>"`. The sandbox
  wakes to run the command and stays awake until it finishes, for up to 30 minutes. You're woken if the command
  fails, or right away if there's no command.
  - That's how anything runs on a schedule here, since nothing runs in a sleeping sandbox. To have your app do the
    work, call it on localhost, where the endpoint needn't be public:
    `--run "curl -fsS --max-time 900 http://localhost:3000/tasks/digest"`. Without `-f`, curl succeeds on an error
    status, and you'd never hear about it.
  - For work that should carry on after your turn ends, such as a long import, `--at 1m --run "…"` keeps the sandbox
    awake until it's done.
  - Once the command is done, and nothing else needs the sandbox, it goes back to sleep within seconds. So a quick
    check costs seconds of machine time, but each one is paid for, and a schedule keeps paying until it's cancelled:
    every fifteen minutes is nearly a hundred wakes a day. Check as often as the job needs, and cancel a check once
    its reason is gone. A wake-up without a command starts a turn, which sends the model your whole session before it
    does anything, so on a schedule it adds up.
- `dream wake --cron "<expr>" --task "<brief>" --model <model> --effort <effort> "why"` (or `--at`) runs a task in a
  session of its own when it fires, instead of waking you: a new conversation on the model and effort you give, named
  as your subagents' are, that starts from the brief.
  - It knows only the brief and what it finds in the project's files, so the brief carries what the job needs: what
    to do, where things are, how to tell it went right, and whether to tell the person. `--task -` reads the brief
    from stdin.
  - It has the project's files and `dream`. It doesn't wake you when it succeeds. It wakes you with `dream wake` when
    it can't do the job, and you're woken with its last words if it fails outright: an error, half an hour without
    finishing, or a usage limit.
  - Its last message is its report, which `dream wake list` shows under the wake with how the run went.
  - Its tokens count for this project like a turn's, but it starts small instead of re-sending your session, so a
    weekly episode or a morning digest written by a model costs what writing it takes.
- `dream wake "why"` wakes you now. An app can call it, from an error handler say, whenever it's running, which is
  only while the sandbox is awake.
- `dream wake list` and `dream wake cancel <id>` show and remove scheduled wake-ups.
